/* =============================================================================
 * hidws.js — Remote WebHID provider for FiiO Control
 *
 * Adds an OPTIONAL "Remote" connection mode that talks to a `hidws` WebSocket
 * backend (https://github.com/Ircama/hidws) instead of (or in addition to)
 * WebHID, mirroring the remote transport of kt02h20-control / Audiocular-Aura.
 *
 * When the dialog's "Remote" option is selected, `navigator.hid` is
 * transparently proxied so the (prebuilt) FiiO app keeps working unchanged: requestDevice(),
 * open(), sendReport(), sendFeatureReport() and inputreport events are all
 * forwarded to the hidws backend over WebSocket. Local (USB / WebHID) mode
 * falls back to the browser's real WebHID API.
 *
 * Wire protocol (JSON over WebSocket, identical to hidws):
 *   C→S  {"cmd":"list"}
 *   C→S  {"cmd":"open","vendorId":N,"productId":N}
 *   C→S  {"cmd":"send_report","reportId":N,"data":[...]}
 *   C→S  {"cmd":"send_feature_report","reportId":N,"data":[...]}
 *   C→S  {"cmd":"close"}
 *   S→C  {"type":"device_list","devices":[...]}
 *   S→C  {"type":"opened","vendorId":N,"productId":N,"productName":"...",...}
 *   S→C  {"type":"input_report","reportId":N,"data":[...]}
 *   S→C  {"type":"error","message":"..."}
 *   S→C  {"type":"closed"}
 *
 * NOTES
 * - hidws forwards the raw hid_read buffer in input_report. For numbered input
 *   reports the first byte is the report ID; WebHID strips it. Set
 *   STRIP_INPUT_REPORT_ID below if the frontend expects WebHID-style buffers.
 * - A "Remote" option is injected into the app's own "Connect Type" dialog
 *   (the Element Plus form offering USB / Serial Port), so there is no
 *   floating panel. The dialog's existing "Connect" button drives the
 *   connection: with Remote selected the navigator.hid proxy forwards
 *   requestDevice() to the hidws backend.
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__fiioHidwsLoaded) return;
  window.__fiioHidwsLoaded = true;

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */
  var CONN_MODE_KEY = 'fiio_conn_mode';        // 'local' | 'remote'
  var REMOTE_URL_KEY = 'fiio_remote_url';
  var DEFAULT_REMOTE_URL = 'ws://localhost:9001';
  var STRIP_INPUT_REPORT_ID = true;            // match WebHID inputreport data
  var OPEN_TIMEOUT_MS = 5000;

  var REAL_HID = null;
  try { REAL_HID = navigator.hid; } catch (e) { REAL_HID = null; }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  function remoteSendJson(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  /* ------------------------------------------------------------------ *
   * RemoteHIDDevice — mimics the WebHID HIDDevice interface over the
   * hidws WebSocket, so the FiiO app treats it like a local device.
   * ------------------------------------------------------------------ */
  function RemoteHIDDevice(vendorId, productId, productName, ws) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName || 'Remote device';
    this.collections = [];
    this.opened = true;
    this._ws = ws;
    this._handlers = new Map();       // 'inputreport' -> Set<{handler, once}>
    this.oninputreport = null;        // HIDDevice.oninputreport
  }

  RemoteHIDDevice.prototype.open = function () { this.opened = true; return Promise.resolve(); };

  RemoteHIDDevice.prototype.close = function () {
    this.opened = false;
    remoteSendJson(this._ws, { cmd: 'close' });
    try { this._ws.close(); } catch (e) {}
    this._handlers.clear();
    this.oninputreport = null;
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.sendReport = function (reportId, data) {
    remoteSendJson(this._ws, { cmd: 'send_report', reportId: reportId || 0, data: Array.from(toBytes(data)) });
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.sendFeatureReport = function (reportId, data) {
    remoteSendJson(this._ws, { cmd: 'send_feature_report', reportId: reportId || 0, data: Array.from(toBytes(data)) });
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.receiveFeatureReport = function () {
    return Promise.resolve(new DataView(new ArrayBuffer(0)));
  };

  RemoteHIDDevice.prototype.addEventListener = function (type, handler, options) {
    if (type !== 'inputreport' || typeof handler !== 'function') return;
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add({ handler: handler, once: !!(options && options.once) });
  };

  RemoteHIDDevice.prototype.removeEventListener = function (type, handler) {
    if (type !== 'inputreport') return;
    var set = this._handlers.get(type);
    if (!set) return;
    set.forEach(function (h) { if (h.handler === handler) set.delete(h); });
  };

  RemoteHIDDevice.prototype._dispatchInputReport = function (reportId, rawData) {
    var bytes = toBytes(rawData);

    // hidws forwards the raw hid_read buffer; for numbered input reports the
    // first byte is the report-ID byte, which WebHID strips from inputreport.
    if (STRIP_INPUT_REPORT_ID && reportId > 0 && bytes.length > 0 && bytes[0] === reportId) {
      bytes = bytes.subarray(1);
    }

    var buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    var event = { reportId: reportId, data: new DataView(buffer) };

    var set = this._handlers.get('inputreport');
    if (set) {
      set.forEach(function (h) {
        if (h.once) this.removeEventListener('inputreport', h.handler);
        try { h.handler(event); } catch (err) { console.error('[hidws] inputreport handler error:', err); }
      }, this);
    }
    if (typeof this.oninputreport === 'function') {
      try { this.oninputreport(event); } catch (err) { console.error('[hidws] oninputreport error:', err); }
    }
  };

  /* ------------------------------------------------------------------ *
   * Transport: list / open on the hidws backend
   * ------------------------------------------------------------------ */
  function listRemoteDevices(url) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      var timeout = setTimeout(function () { try { ws.close(); } catch (e) {} reject(new Error('Connection timeout')); }, OPEN_TIMEOUT_MS);

      ws.onopen = function () { clearTimeout(timeout); remoteSendJson(ws, { cmd: 'list' }); };
      ws.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'device_list') { try { ws.close(); } catch (e) {} resolve(msg.devices || []); }
          else if (msg.type === 'error') { try { ws.close(); } catch (e) {} reject(new Error(msg.message || 'Backend error')); }
        } catch (err) { try { ws.close(); } catch (e) {} reject(new Error('Invalid backend response')); }
      };
      ws.onerror = function () { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); };
      ws.onclose = function () { clearTimeout(timeout); };
    });
  }

  function openRemoteDevice(url, vendorId, productId, onClosed) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      var timeout = setTimeout(function () { try { ws.close(); } catch (e) {} reject(new Error('Connection timeout')); }, OPEN_TIMEOUT_MS);

      ws.onopen = function () {
        clearTimeout(timeout);
        remoteSendJson(ws, { cmd: 'open', vendorId: vendorId, productId: productId });
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        if (msg.type === 'opened') {
          var dev = new RemoteHIDDevice(
            msg.vendorId !== undefined ? msg.vendorId : vendorId,
            msg.productId !== undefined ? msg.productId : productId,
            msg.productName || 'Remote device', ws);
          ws.onmessage = function (ev2) {
            var m;
            try { m = JSON.parse(ev2.data); } catch (err) { return; }
            if (m.type === 'input_report') dev._dispatchInputReport(m.reportId !== undefined ? m.reportId : 0, m.data || []);
            else if (m.type === 'closed') { dev.opened = false; try { ws.close(); } catch (e) {} onClosed && onClosed(); }
          };
          ws.onclose = function () { dev.opened = false; onClosed && onClosed(); };
          resolve(dev);
        } else if (msg.type === 'error') {
          try { ws.close(); } catch (e) {}
          reject(new Error(msg.message || 'Failed to open device'));
        }
      };
      ws.onerror = function () { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); };
      ws.onclose = function () { clearTimeout(timeout); };
    });
  }

  /* ------------------------------------------------------------------ *
   * State + navigator.hid proxy
   * ------------------------------------------------------------------ */
  var state = {
    mode: (function () { try { return localStorage.getItem(CONN_MODE_KEY) === 'remote' ? 'remote' : 'local'; } catch (e) { return 'local'; } })(),
    url: (function () { try { return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL; } catch (e) { return DEFAULT_REMOTE_URL; } })(),
    remoteDevice: null,
    deviceList: [],
    selectedVid: null,
    selectedPid: null,
    disconnectHandlers: [],
  };

  function setMode(mode) {
    state.mode = mode === 'remote' ? 'remote' : 'local';
    try { localStorage.setItem(CONN_MODE_KEY, state.mode); } catch (e) {}
    syncModeUI();
  }

  function onRemoteClosed() {
    state.remoteDevice = null;
    var ev = { device: state.remoteDevice };
    state.disconnectHandlers.forEach(function (h) {
      try { h(ev); } catch (e) { console.error('[hidws] disconnect handler error:', e); }
    });
    state.disconnectHandlers = [];
    syncModeUI();
  }

  var hidProxy = {
    requestDevice: function (options) {
      if (state.mode !== 'remote') {
        if (!REAL_HID) return Promise.reject(new Error('WebHID is not supported by this browser (local mode). Use a Chromium browser or switch to Remote mode.'));
        return REAL_HID.requestDevice(options || {});
      }

      // ---- Remote mode ----
      if (state.remoteDevice) return Promise.resolve([state.remoteDevice]);

      var url = state.url;
      return listRemoteDevices(url).then(function (devices) {
        if (!devices.length) { setStatus('No remote devices found', 'error'); return []; }
        var list = devices;
        if (options && options.filters && options.filters.length) {
          list = devices.filter(function (d) {
            return options.filters.some(function (f) {
              return (f.vendorId === undefined || f.vendorId === d.vendorId) &&
                     (f.productId === undefined || f.productId === d.productId);
            });
          });
        }
        if (!list.length) { setStatus('No matching remote device', 'error'); return []; }

        // Prefer the device selected in the dialog's list, else the first match.
        var target = list[0];
        if (state.selectedVid != null) {
          for (var i = 0; i < list.length; i++) {
            if (list[i].vendorId === state.selectedVid && list[i].productId === state.selectedPid) { target = list[i]; break; }
          }
        }
        setStatus('Opening ' + target.productName + '…', 'working');
        return openRemoteDevice(url, target.vendorId, target.productId, onRemoteClosed).then(function (dev) {
          state.remoteDevice = dev;
          setStatus('Connected: ' + dev.productName, 'ok');
          syncModeUI();
          return [dev];
        });
      });
    },

    getDevices: function () {
      if (state.mode === 'remote') return Promise.resolve(state.remoteDevice ? [state.remoteDevice] : []);
      if (!REAL_HID) return Promise.resolve([]);
      return REAL_HID.getDevices();
    },

    addEventListener: function (type, handler, options) {
      if (type !== 'disconnect' || typeof handler !== 'function') return;
      state.disconnectHandlers.push(handler);
    },

    removeEventListener: function (type, handler) {
      if (type !== 'disconnect') return;
      state.disconnectHandlers = state.disconnectHandlers.filter(function (h) { return h !== handler; });
    },

    ondisconnect: null,
  };

  // Install the proxy so the app sees our remote-capable navigator.hid.
  function installProxy() {
    try {
      Object.defineProperty(navigator, 'hid', {
        configurable: true,
        get: function () { return hidProxy; },
      });
      return true;
    } catch (e) {
      try {
        Object.defineProperty(Navigator.prototype, 'hid', {
          configurable: true,
          get: function () { return hidProxy; },
        });
        return true;
      } catch (e2) {
        console.error('[hidws] Could not override navigator.hid:', e2);
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Integration into the app's "Connect Type" dialog
   * ------------------------------------------------------------------ *
   * The Element Plus ids on the dialog body (e.g. el-id-6042-13 / el-id-6862-13)
   * are auto-generated and change between renders, so the dialog is located
   * robustly via its `.dialog-content` / `.radio-item` structure. A "Remote"
   * radio item and a hidws config section (WebSocket URL + "List devices")
   * are injected; the dialog's own "Connect" button triggers the connection
   * through the navigator.hid proxy. No separate connect button is needed.
   * ------------------------------------------------------------------ */
  var dialogRoot = null;   // current .dialog-content element
  var ui = null;           // injected elements

  function setStatus(text, kind) {
    if (!ui) return;
    ui.statusEl.textContent = text;
    ui.statusEl.className = 'fh-remote-status fh-status-' + (kind || 'idle');
  }

  function makeElement(tag, attrs, text) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildRemoteSection() {
    var cfg = makeElement('div', { class: 'fh-remote-config' }, '');
    cfg.style.display = 'none';

    var label = makeElement('div', { class: 'fh-remote-label' }, 'Remote backend (hidws)');
    var urlRow = makeElement('div', { class: 'fh-remote-row' }, '');
    var urlInput = makeElement('input', { type: 'text', class: 'fh-remote-url', spellcheck: 'false', placeholder: 'ws://host:9001' }, '');
    urlInput.value = state.url;
    var listBtn = makeElement('button', { type: 'button', class: 'el-button el-button--primary fh-remote-list' }, 'List devices');
    urlRow.appendChild(urlInput);
    urlRow.appendChild(listBtn);

    var selRow = makeElement('div', { class: 'fh-remote-row' }, '');
    var sel = makeElement('select', { class: 'fh-remote-select' }, '');
    selRow.appendChild(sel);

    var statusEl = makeElement('div', { class: 'fh-remote-status fh-status-idle' }, '');

    cfg.appendChild(label);
    cfg.appendChild(urlRow);
    cfg.appendChild(selRow);
    cfg.appendChild(statusEl);

    urlInput.addEventListener('change', function () {
      var v = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = v; urlInput.value = v;
      try { localStorage.setItem(REMOTE_URL_KEY, v); } catch (e) {}
    });

    listBtn.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = url;
      try { localStorage.setItem(REMOTE_URL_KEY, url); } catch (e) {}
      setStatus('Listing devices…', 'working');
      listBtn.disabled = true;
      try {
        var devices = await listRemoteDevices(url);
        state.deviceList = devices;
        sel.innerHTML = '';
        if (!devices.length) {
          sel.appendChild(makeElement('option', {}, 'No devices found'));
          state.selectedVid = state.selectedPid = null;
          setStatus('No devices found on the backend.', 'error');
        } else {
          devices.forEach(function (d) {
            sel.appendChild(makeElement('option', { value: d.vendorId + ':' + d.productId },
              (d.productName || 'HID device') + ' (' + (d.vendorId ? '0x' + d.vendorId.toString(16) : '?') + ':' + (d.productId ? '0x' + d.productId.toString(16) : '?') + ')'));
          });
          state.selectedVid = devices[0].vendorId;
          state.selectedPid = devices[0].productId;
          setStatus(devices.length + ' device(s) found — pick one and press Connect.', 'ok');
        }
      } catch (err) {
        setStatus('List failed: ' + err.message, 'error');
      } finally {
        listBtn.disabled = false;
      }
    });

    sel.addEventListener('change', function () {
      var parts = (sel.value || '').split(':');
      state.selectedVid = parts[0] !== undefined && parts[0] !== '' ? Number(parts[0]) : null;
      state.selectedPid = parts[1] !== undefined && parts[1] !== '' ? Number(parts[1]) : null;
    });

    return { cfg: cfg, urlInput: urlInput, listBtn: listBtn, sel: sel, statusEl: statusEl };
  }

  function injectDialog(content) {
    dialogRoot = content;

    // --- "Remote" radio item (mirrors the native el-radio items) ---
    var radioItem = makeElement('div', { class: 'radio-item fh-radio-item' }, '');
    var label = makeElement('label', { class: 'el-radio el-radio--large fh-remote-radio' }, '');
    var inputSpan = makeElement('span', { class: 'el-radio__input' }, '');
    var input = makeElement('input', { type: 'radio', class: 'el-radio__original fh-remote-original', name: 'fh-remote-mode', value: '2' }, '');
    var inner = makeElement('span', { class: 'el-radio__inner' }, '');
    var labelWrap = makeElement('span', { class: 'el-radio__label' }, '');
    var textSpan = makeElement('span', { class: 'el-text connect-radio-label' }, 'Remote');
    labelWrap.appendChild(textSpan);
    inputSpan.appendChild(input);
    inputSpan.appendChild(inner);
    label.appendChild(inputSpan);
    label.appendChild(labelWrap);
    radioItem.appendChild(label);
    var desc = makeElement('div', { class: 'dialog-content-desc fh-remote-desc' }, 'Remote backend (hidws) over WebSocket');
    radioItem.appendChild(desc);

    // --- hidws config section ---
    var parts = buildRemoteSection();

    content.appendChild(radioItem);
    content.appendChild(parts.cfg);

    ui = {
      radioItem: radioItem,
      radioInput: input,
      radioInputSpan: inputSpan,
      radioLabel: label,
      cfg: parts.cfg,
      urlInput: parts.urlInput,
      listBtn: parts.listBtn,
      sel: parts.sel,
      statusEl: parts.statusEl,
    };

    // --- Click handling (delegated on the dialog content) ---
    content.addEventListener('click', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.radio-item') : null;
      if (!item) return;
      if (item.classList.contains('fh-radio-item')) setMode('remote');
      else setMode('local');
      syncModeUI();
    });

    syncModeUI();
  }

  // Keep the app's connectType on HID (0 = USB) while Remote is selected, so
  // the dialog's "Connect" button routes through navigator.hid -> our proxy.
  function ensureHidPath() {
    if (!dialogRoot) return;
    var usb = dialogRoot.querySelector('.el-radio__original[value="0"]');
    if (usb && !usb.checked) {
      usb.checked = true;
      // Sync Vue's v-model. Our own click handler only listens to 'click', so
      // this synthetic 'change' cannot flip the mode back to local.
      usb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function syncModeUI() {
    if (!ui) return;
    var remote = state.mode === 'remote';
    ui.radioInput.checked = remote;
    ui.radioLabel.classList.toggle('is-checked', remote);
    ui.radioInputSpan.classList.toggle('is-checked', remote);
    ui.cfg.style.display = remote ? 'block' : 'none';
    ui.urlInput.value = state.url;
    if (dialogRoot) dialogRoot.classList.toggle('fh-remote-active', remote);
    if (remote) ensureHidPath();
  }

  // Watch for the Connect Type dialog appearing / being re-created.
  var observer = new MutationObserver(function () {
    var content = document.querySelector('.el-dialog .dialog-content');
    if (!content) {
      dialogRoot = null;
      ui = null;
      return;
    }
    if (content !== dialogRoot || !content.querySelector('.fh-remote-config')) {
      injectDialog(content);
    } else {
      syncModeUI();
    }
  });

  /* --- auto-eq: eq-panel toggleable overlay --- */
  var EQ_PANEL_KEY = 'fiio_eqpanel_open';
  function eqPanelState() { try { return localStorage.getItem(EQ_PANEL_KEY) === '1'; } catch (e) { return false; } }
  function setEqPanelState(open) { try { localStorage.setItem(EQ_PANEL_KEY, open ? '1' : '0'); } catch (e) {} }
  function updateEqPanelToggle(btn, open) {
    if (!btn) return;
    btn.textContent = open ? '\u2715 Close panel' : '\u2699 EQ panel';
    btn.title = open ? 'Close the EQ settings panel' : 'Open the EQ settings panel as an overlay';
  }
  function ensureEqPanelUI() {
    var panel = document.getElementById('eq-panel');
    var btn = document.getElementById('fh-eqpanel-toggle');
    if (!panel) {
      if (btn) btn.style.display = 'none';
      return;
    }
    var open = eqPanelState();
    panel.classList.toggle('fh-eqpanel-hidden', !open);
    if (!btn) {
      btn = makeElement('button', { type: 'button', id: 'fh-eqpanel-toggle' }, '');
      btn.addEventListener('click', function () {
        var p = document.getElementById('eq-panel');
        var now = !eqPanelState();
        setEqPanelState(now);
        if (p) p.classList.toggle('fh-eqpanel-hidden', !now);
        updateEqPanelToggle(btn, now);
      });
      document.body.appendChild(btn);
    }
    btn.style.display = 'inline-flex';
    updateEqPanelToggle(btn, open);
  }
  var eqPanelObserver = new MutationObserver(function () { ensureEqPanelUI(); });

  /* Styling for the injected elements (matches the Element Plus look) */
  var style = document.createElement('style');
  style.textContent = [
    '.el-dialog .dialog-content .fh-radio-item { cursor:pointer; }',
    '.el-dialog .dialog-content.fh-remote-active .radio-item:not(.fh-radio-item) { opacity:.45; }',
    '.el-dialog .dialog-content.fh-remote-active .radio-item:not(.fh-radio-item) .el-radio.is-checked .el-radio__inner { border-color:var(--el-radio-input-border-color,#dcdfe6) !important; background:var(--el-radio-input-bg-color,#fff) !important; }',
    '.el-dialog .dialog-content.fh-remote-active .radio-item:not(.fh-radio-item) .el-radio__inner::after { transform:scale(0) !important; }',
    '.fh-remote-config { margin-top:10px; padding:10px; border:1px solid rgba(128,128,128,.25); border-radius:8px; display:flex; flex-direction:column; gap:8px; }',
    '.fh-remote-label { font-size:13px; color:var(--el-text-color-secondary, #909399); }',
    '.fh-remote-row { display:flex; gap:8px; align-items:center; }',
    '.fh-remote-url { flex:1; min-width:0; height:32px; border:1px solid var(--el-border-color, #dcdfe6); border-radius:6px; background:var(--el-fill-color-blank, #fff); color:var(--el-text-color-primary, #303133); padding:0 10px; font-size:13px; }',
    '.fh-remote-select { flex:1; min-width:0; height:32px; border:1px solid var(--el-border-color, #dcdfe6); border-radius:6px; background:var(--el-fill-color-blank, #fff); color:var(--el-text-color-primary, #303133); padding:0 8px; font-size:13px; }',
    '.fh-remote-list { margin-left:auto; }',
    '.fh-remote-status { font-size:12px; min-height:14px; word-break:break-word; color:var(--el-text-color-secondary, #909399); }',
    '.fh-remote-status.fh-status-working { color:#e6a23c; }',
    '.fh-remote-status.fh-status-ok { color:#67c23a; }',
    '.fh-remote-status.fh-status-error { color:#f56c6c; }',
    // --- auto-eq: eq-panel as a toggleable opaque overlay (theme colors) ---
    '#eq-panel { position:fixed !important; top:92px !important; right:12px !important; left:auto !important; width:min(440px, calc(100vw - 24px)) !important; max-height:calc(100vh - 104px) !important; overflow-y:auto !important; z-index:3000 !important; background:var(--el-bg-color-overlay, var(--el-bg-color, #141414)) !important; color:var(--el-text-color-primary, #E5EAF3) !important; border:1px solid var(--el-border-color, #4C4D4F) !important; border-radius:10px !important; box-shadow:0 8px 24px rgba(0,0,0,.35) !important; padding:12px !important; opacity:1 !important; }',
    '#eq-panel.fh-eqpanel-hidden { display:none !important; }',
    '#fh-eqpanel-toggle { position:fixed !important; top:48px !important; right:12px !important; z-index:3001 !important; display:inline-flex !important; align-items:center !important; gap:6px !important; padding:7px 13px !important; font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; color:var(--el-color-white, #fff) !important; background:var(--el-color-primary, #c8102e) !important; border:none !important; border-radius:8px !important; cursor:pointer !important; box-shadow:var(--el-box-shadow-lighter, 0 2px 10px rgba(0,0,0,.3)) !important; user-select:none !important; }',
    '#fh-eqpanel-toggle:hover { filter:brightness(1.08) !important; }',
    '#fh-eqpanel-toggle:active { transform:translateY(1px) !important; }',
  ].join('\n');
  document.head.appendChild(style);

  // Install proxy BEFORE the app bundle runs.
  installProxy();

  // Watch for the dialog (this script runs from <head>, before <body> exists).
  var started = false;
  function startObserver() {
    if (started) return;
    if (!document.body) { setTimeout(startObserver, 50); return; }
    started = true;
    observer.observe(document.body, { childList: true, subtree: true });
    eqPanelObserver.observe(document.body, { childList: true, subtree: true });
    var initial = document.querySelector('.el-dialog .dialog-content');
    if (initial) injectDialog(initial);
    ensureEqPanelUI();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

  // Expose a small debug handle.
  window.__fiioHidws = { state: state, hidProxy: hidProxy, listRemoteDevices: listRemoteDevices, openRemoteDevice: openRemoteDevice, syncModeUI: syncModeUI };
})();
