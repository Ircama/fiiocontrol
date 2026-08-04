/* =============================================================================
 * localstorage.js — Local personal-preset backend for FiiO Control
 *
 * Lets the app use a LOCAL database (browser localStorage) for every
 * "Personal" feature instead of (or as an option to) the remote portal
 * https://fiiocontrol.fiio.com, so the app does NOT depend on that portal
 * for its application features:
 *
 *   - "Save to Personal"           -> __fiioLocal.addPeq()       (local)
 *   - "Override data to Personal"  -> __fiioLocal.updatePeq()    (local)
 *   - /equalizer/personal list     -> __fiioLocal.getPeq()       (local)
 *   - Delete / Share               -> __fiioLocal.deletePeq() /
 *                                     __fiioLocal.setPeqIsshare() (local)
 *   - Shared presets               -> __fiioLocal.getSharePeq()  (local)
 *   - Avatar / user info           -> __fiioLocal.getUserInfo()  (local user)
 *
 * The bundled API functions (public/static/js/index-WZB3nC8k.js) are patched
 * to route through window.__fiioLocal whenever local mode is active.
 *
 * Local mode is the DEFAULT: the avatar (el-avatar el-avatar--circle) shows
 * the local user instead of the login dialog. To go back to the remote
 * portal, set localStorage "fiio_use_local" to "0" (or call
 * window.__fiioLocal.setLocal(false)).
 *
 * The local presets database lives under localStorage "fiio_local_personal"
 * (a JSON array), sharing the same item model as the remote portal:
 *   { id, styleName, description, userId, customOrNot, shareOrNot,
 *     deviceType, masterGain, eqParamsJson }
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__fiioLocal) return;
  window.__fiioLocalLoaded = true;

  var DB_KEY = 'fiio_local_personal';   // local presets database
  var MODE_KEY = 'fiio_use_local';      // '1' (default) = local, '0' = remote

  var LOCAL_USER = {
    userId: 'local',
    userName: 'Local',
    avatar: '',
    sex: 0,
    mobile: '',
    email: '',
    province: '',
    city: '',
  };

  function storage() { try { return window.localStorage; } catch (e) { return null; } }

  /* Local mode is the default (any value != "0" => local). */
  function isLocal() {
    var s = storage();
    if (!s) return true;
    try { return s.getItem(MODE_KEY) !== '0'; } catch (e) { return true; }
  }

  function setLocal(v) {
    var s = storage();
    if (!s) return;
    try { s.setItem(MODE_KEY, v ? '1' : '0'); } catch (e) {}
  }

  function loadDB() {
    var s = storage();
    if (!s) return [];
    try {
      var raw = s.getItem(DB_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveDB(db) {
    var s = storage();
    if (!s) return;
    try { s.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {}
  }

  function nextId(db) {
    var m = 0;
    for (var i = 0; i < db.length; i++) {
      var id = Number(db[i].id) || 0;
      if (id > m) m = id;
    }
    return m + 1;
  }

  function ok(data) { return { code: 200, msg: 'ok', data: data }; }
  function okItem(item) {
    return { code: 200, msg: 'ok', data: [Object.assign({ successOrNot: true }, item)] };
  }
  function list(req) {
    return (req && Array.isArray(req.peqList)) ? req.peqList : [];
  }
  function byId(db, id) {
    for (var i = 0; i < db.length; i++)
      if (String(db[i].id) === String(id)) return i;
    return -1;
  }

  /* --- local personal-preset CRUD (mirrors the remote API shapes) --- */

  function getPeq() { return Promise.resolve(ok(loadDB())); }

  function addPeq(req) {
    var db = loadDB();
    var items = list(req).map(function (it) {
      var copy = Object.assign({}, it);
      copy.id = nextId(db);
      if (!copy.userId) copy.userId = 'local';
      if (copy.customOrNot === undefined) copy.customOrNot = true;
      if (copy.shareOrNot === undefined) copy.shareOrNot = false;
      db.push(copy);
      return copy;
    });
    saveDB(db);
    return Promise.resolve(okItem(items[items.length - 1] || {}));
  }

  function updatePeq(req) {
    var db = loadDB();
    var items = list(req);
    items.forEach(function (it) {
      if (it.id === undefined || it.id === null) return;
      var idx = byId(db, it.id);
      if (idx !== -1) db[idx] = Object.assign({}, db[idx], it);
    });
    saveDB(db);
    return Promise.resolve(okItem(items[items.length - 1] || {}));
  }

  function deletePeq(req) {
    var db = loadDB();
    list(req).forEach(function (it) {
      db = db.filter(function (x) { return String(x.id) !== String(it.id); });
    });
    saveDB(db);
    return Promise.resolve(ok([{ successOrNot: true }]));
  }

  function setPeqIsshare(req) {
    var db = loadDB();
    var items = list(req);
    items.forEach(function (it) {
      var idx = byId(db, it.id);
      if (idx !== -1) db[idx].shareOrNot = !!it.shareOrNot;
    });
    saveDB(db);
    return Promise.resolve(okItem(items[items.length - 1] || {}));
  }

  function getSharePeq() {
    return Promise.resolve(ok(loadDB().filter(function (x) { return !!x.shareOrNot; })));
  }

  /* --- local user (avatar shows "Local" instead of login) --- */

  function getUserInfo() { return LOCAL_USER; }

  window.__fiioLocal = {
    isLocal: isLocal,
    setLocal: setLocal,
    getUserInfo: getUserInfo,
    getPeq: getPeq,
    addPeq: addPeq,
    updatePeq: updatePeq,
    deletePeq: deletePeq,
    setPeqIsshare: setPeqIsshare,
    getSharePeq: getSharePeq,
  };

  /* Convenience console toggle: window.__fiioLocalSetMode(false) -> remote */
  try { window.__fiioLocalSetMode = setLocal; } catch (e) {}
})();
