/* =============================================================================
 * hidws.js — Remote WebHID provider for FiiO Control
 *
 * Adds an OPTIONAL "Remote" connection mode that talks to a `hidws` WebSocket
 * backend (https://github.com/Ircama/hidws) instead of (or in addition to)
 * WebHID, mirroring the remote transport of kt02h20-control / Audiocular-Aura.
 *
 * When the widget is set to "Remote" mode, `navigator.hid` is transparently
 * proxied so the (prebuilt) FiiO app keeps working unchanged: requestDevice(),
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
 * - The widget is a floating panel; it does not touch the Vue app's DOM.
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
    if (widget) widget.refresh();
  }

  function onRemoteClosed() {
    state.remoteDevice = null;
    var ev = { device: state.remoteDevice };
    state.disconnectHandlers.forEach(function (h) {
      try { h(ev); } catch (e) { console.error('[hidws] disconnect handler error:', e); }
    });
    state.disconnectHandlers = [];
    if (widget) widget.refresh();
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

        // Prefer the device selected in the widget, else the first match.
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
          if (widget) widget.refresh();
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
   * Floating widget (inspired by kt02h20-control's remote UI)
   * ------------------------------------------------------------------ */
  var widget = null;

  function setStatus(text, kind) {
    if (!widget) return;
    var el = widget.statusEl;
    el.textContent = text;
    el.className = 'fh-status fh-status-' + (kind || 'idle');
  }

  function buildWidget() {
    var root = document.createElement('div');
    root.id = 'fh-hidws-widget';
    root.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
      'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
      'font-size:12px', 'line-height:1.4', 'color:#e5e7eb',
      'background:#111827', 'border:1px solid #374151', 'border-radius:10px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)', 'overflow:hidden', 'max-width:340px',
    ].join(';');

    /* Header / collapse toggle */
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;cursor:pointer;background:#1f2937;user-select:none;';
    var title = document.createElement('span');
    title.textContent = 'FiiO Control · Remote (hidws)';
    title.style.cssText = 'font-weight:600;font-size:12px;';
    var toggle = document.createElement('span');
    toggle.textContent = '▾';
    toggle.style.cssText = 'font-size:10px;color:#9ca3af;';
    head.appendChild(title);
    head.appendChild(toggle);

    /* Body */
    var body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px;display:flex;flex-direction:column;gap:8px;';

    /* Mode toggle */
    var modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    var modeLabel = document.createElement('span');
    modeLabel.textContent = 'Mode:';
    modeLabel.style.cssText = 'color:#9ca3af;';
    var btnUsb = mkButton('USB', 'Connect via WebHID (USB)', 'fh-mode-btn');
    var btnRemote = mkButton('Remote', 'Connect to a remote hidws backend over WebSocket', 'fh-mode-btn');
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(btnUsb);
    modeRow.appendChild(btnRemote);

    /* Remote config */
    var cfg = document.createElement('div');
    cfg.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    var cfgLabel = document.createElement('span');
    cfgLabel.textContent = 'Remote backend (hidws)';
    cfgLabel.style.cssText = 'color:#9ca3af;';
    var urlRow = document.createElement('div');
    urlRow.style.cssText = 'display:flex;gap:6px;';
    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.spellcheck = false;
    urlInput.placeholder = 'ws://host:9001';
    urlInput.value = state.url;
    urlInput.style.cssText = 'flex:1;min-width:0;background:#0b1220;border:1px solid #374151;border-radius:6px;color:#e5e7eb;padding:5px 8px;font-size:12px;';
    urlRow.appendChild(urlInput);
    var btnList = mkButton('List devices', 'List HID devices on the remote backend', 'fh-btn fh-btn-secondary');
    urlRow.appendChild(btnList);

    var selRow = document.createElement('div');
    selRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    var sel = document.createElement('select');
    sel.style.cssText = 'flex:1;min-width:0;background:#0b1220;border:1px solid #374151;border-radius:6px;color:#e5e7eb;padding:5px 6px;font-size:12px;';
    var btnConnectRemote = mkButton('Connect remote', 'Open the selected device on the remote backend', 'fh-btn fh-btn-primary');
    selRow.appendChild(sel);
    selRow.appendChild(btnConnectRemote);

    var statusEl = document.createElement('div');
    statusEl.className = 'fh-status fh-status-idle';
    statusEl.textContent = state.mode === 'remote' ? 'Remote mode — list devices to begin.' : 'Local (WebHID) mode.';
    statusEl.style.cssText = 'color:#9ca3af;font-size:11px;min-height:14px;word-break:break-word;';

    cfg.appendChild(cfgLabel);
    cfg.appendChild(urlRow);
    cfg.appendChild(selRow);

    body.appendChild(modeRow);
    body.appendChild(cfg);
    body.appendChild(statusEl);

    root.appendChild(head);
    root.appendChild(body);

    /* Widget API */
    var hidden = false;
    var api = {
      root: root,
      statusEl: statusEl,
      refresh: function () {
        btnUsb.classList.toggle('fh-active', state.mode === 'local');
        btnRemote.classList.toggle('fh-active', state.mode === 'remote');
        cfg.style.display = state.mode === 'remote' ? 'flex' : 'none';
        urlInput.value = state.url;
        if (state.mode !== 'remote' && state.remoteDevice) setStatus('Remote disconnected.', 'idle');
        if (state.mode === 'remote' && state.remoteDevice) setStatus('Connected: ' + state.remoteDevice.productName, 'ok');
      },
    };

    /* Events */
    head.addEventListener('click', function () {
      hidden = !hidden;
      body.style.display = hidden ? 'none' : 'flex';
      toggle.textContent = hidden ? '▸' : '▾';
    });

    btnUsb.addEventListener('click', function () {
      setMode('local');
      setStatus('Local (WebHID) mode.', 'idle');
    });
    btnRemote.addEventListener('click', function () {
      setMode('remote');
      setStatus('Remote mode — list devices to begin.', 'idle');
    });

    urlInput.addEventListener('change', function () {
      var v = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = v;
      urlInput.value = v;
      try { localStorage.setItem(REMOTE_URL_KEY, v); } catch (e) {}
    });

    btnList.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = url;
      try { localStorage.setItem(REMOTE_URL_KEY, url); } catch (e) {}
      setStatus('Listing devices…', 'working');
      btnList.disabled = true;
      try {
        var devices = await listRemoteDevices(url);
        state.deviceList = devices;
        sel.innerHTML = '';
        if (!devices.length) {
          var opt = document.createElement('option');
          opt.textContent = 'No devices found';
          opt.value = '';
          sel.appendChild(opt);
          state.selectedVid = state.selectedPid = null;
          setStatus('No devices found on the backend.', 'error');
        } else {
          devices.forEach(function (d) {
            var o = document.createElement('option');
            o.value = d.vendorId + ':' + d.productId;
            o.textContent = (d.productName || 'HID device') + ' (' + (d.vendorId ? '0x' + d.vendorId.toString(16) : '?') + ':' + (d.productId ? '0x' + d.productId.toString(16) : '?') + ')';
            sel.appendChild(o);
          });
          state.selectedVid = devices[0].vendorId;
          state.selectedPid = devices[0].productId;
          setStatus(devices.length + ' device(s) found — pick one and connect.', 'ok');
        }
      } catch (err) {
        setStatus('List failed: ' + err.message, 'error');
      } finally {
        btnList.disabled = false;
      }
    });

    sel.addEventListener('change', function () {
      var parts = (sel.value || '').split(':');
      state.selectedVid = parts[0] !== undefined && parts[0] !== '' ? Number(parts[0]) : null;
      state.selectedPid = parts[1] !== undefined && parts[1] !== '' ? Number(parts[1]) : null;
    });

    btnConnectRemote.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = url;
      try { localStorage.setItem(REMOTE_URL_KEY, url); } catch (e) {}
      if (state.selectedVid == null) { setStatus('Select a device first.', 'error'); return; }
      setStatus('Connecting…', 'working');
      btnConnectRemote.disabled = true;
      try {
        var dev = await openRemoteDevice(url, state.selectedVid, state.selectedPid, onRemoteClosed);
        state.remoteDevice = dev;
        setStatus('Connected: ' + dev.productName, 'ok');
        if (widget) widget.refresh();
      } catch (err) {
        setStatus('Connect failed: ' + err.message, 'error');
      } finally {
        btnConnectRemote.disabled = false;
      }
    });

    return api;
  }

  function mkButton(text, title, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.className = cls || 'fh-btn';
    b.style.cssText = 'border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;color:#e5e7eb;';
    return b;
  }

  /* Styling for mode/primary/secondary buttons */
  var style = document.createElement('style');
  style.textContent = [
    '#fh-hidws-widget button:disabled { opacity:.5; cursor:default; }',
    '#fh-hidws-widget .fh-mode-btn { background:#1f2937; border:1px solid #374151; color:#9ca3af; }',
    '#fh-hidws-widget .fh-mode-btn.fh-active { background:#2563eb; border-color:#2563eb; color:#fff; }',
    '#fh-hidws-widget .fh-btn-primary { background:#2563eb; color:#fff; }',
    '#fh-hidws-widget .fh-btn-secondary { background:#374151; color:#e5e7eb; }',
    '#fh-hidws-widget .fh-status-working { color:#fbbf24; }',
    '#fh-hidws-widget .fh-status-ok { color:#34d399; }',
    '#fh-hidws-widget .fh-status-error { color:#f87171; }',
  ].join('\n');
  document.head.appendChild(style);

  // Install proxy BEFORE the app bundle runs.
  installProxy();

  // Mount the widget once the DOM is ready (this script runs from <head>,
  // before <body> exists).
  function mountWidget() {
    if (!document.body) { requestAnimationFrame(mountWidget); return; }
    if (widget) return;
    widget = buildWidget();
    document.body.appendChild(widget.root);
    widget.refresh();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWidget);
  } else {
    mountWidget();
  }

  // Expose a small debug handle.
  window.__fiioHidws = { state: state, hidProxy: hidProxy, listRemoteDevices: listRemoteDevices, openRemoteDevice: openRemoteDevice };
})();
