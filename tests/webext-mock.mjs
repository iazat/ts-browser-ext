// A minimal stand-in for the WebExtension APIs that background.js touches, so
// the two background scripts can be exercised outside a browser.
//
// Chrome and Firefox differ in how they answer: Chrome takes a callback,
// Firefox returns a promise. The mock supports both from one implementation,
// so the same suite can drive either copy of the extension.
import fs from "node:fs";
import vm from "node:vm";

function respond(cb, value) {
  if (typeof cb === "function") {
    cb(value);
    return undefined;
  }
  return Promise.resolve(value);
}

// loadBackground evaluates a background.js in a fresh sandbox and returns the
// sandbox plus a record of everything the script did to the browser.
//
// `flavor` picks which global the script expects: "chrome" or "browser".
// `extraGlobals` adds to the sandbox, so a test can hand the script an
// environment that lies about which browser it is running in.
// `opts` (a plain object; a legacy caller may pass extra globals directly)
// accepts:
//   globals          — added to the sandbox, e.g. to lie about the browser
//   storage          — seeds storage.local instead of the default profile id
//   storageFailures  — that many reads answer nothing before any work
export function loadBackground(file, flavor, opts = {}) {
  const extraGlobals = opts.globals || (opts.storage || opts.storageFailures ? {} : opts);
  const calls = {
    storage: opts.storage ? { ...opts.storage } : { profileId: "test-profile-id" },
    storageFailures: opts.storageFailures || 0,
    alarmsCreated: [], // alarms the script asked the browser to keep
    proxyListeners: [], // handlers currently registered on proxy.onRequest
    removeMisses: 0, //    removeListener calls that matched no handler
    proxyModes: [], //     modes passed to proxy.settings.set, in order
    toNativeHost: [], //   messages posted to the native messaging port
    toPopup: [], //        messages posted down the popup port
    icons: [], //          icon base names the script asked for
    connects: 0, //        connectNative calls so far
    timers: [], //         {fn, ms} for every setTimeout the script set
  };

  // Each connectNative call hands back a fresh port, as the browser does; the
  // most recent one's listeners are what calls.onNativeDisconnect and
  // calls.onNativeMessage refer to. A port's `error` is Firefox's way of
  // reporting why it disconnected; tests set it before firing onDisconnect.
  let nativePort = null;
  const newNativePort = () => {
    const port = {
      error: null,
      postMessage: (m) => calls.toNativeHost.push(m),
      onDisconnect: {
        addListener: (f) => {
          port.disconnect = f;
          calls.onNativeDisconnect = f;
        },
      },
      onMessage: {
        addListener: (f) => {
          port.message = f;
          calls.onNativeMessage = f;
        },
      },
    };
    nativePort = port;
    calls.nativePort = port;
    return port;
  };

  const api = {
    action: {
      setIcon: (details, cb) => {
        calls.icons.push(details.path);
        return respond(cb, undefined);
      },
    },
    proxy: {
      onRequest: {
        addListener: (fn) => calls.proxyListeners.push(fn),
        removeListener: (fn) => {
          const i = calls.proxyListeners.indexOf(fn);
          if (i === -1) calls.removeMisses++;
          else calls.proxyListeners.splice(i, 1);
        },
      },
      settings: {
        set: (v, cb) => {
          calls.proxyModes.push(v.value.mode);
          return respond(cb, undefined);
        },
      },
    },
    runtime: {
      id: "test-extension-id",
      lastError: null,
      connectNative: (name) => {
        calls.nativeHostName = name;
        calls.connects++;
        return newNativePort();
      },
      onConnect: { addListener: (f) => (calls.onConnect = f) },
      onMessage: { addListener: (f) => (calls.onMessage = f) },
      onStartup: { addListener: (f) => (calls.onStartup = f) },
      onInstalled: { addListener: (f) => (calls.onInstalled = f) },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          if (calls.storageFailures-- > 0) return respond(cb, undefined);
          const wanted = typeof keys === "string" ? [keys] : keys;
          const out = {};
          for (const k of wanted) if (k in calls.storage) out[k] = calls.storage[k];
          return respond(cb, out);
        },
        set: (items, cb) => {
          Object.assign(calls.storage, items);
          return respond(cb, undefined);
        },
      },
    },
    alarms: {
      create: (name, info) => {
        calls.alarmsCreated.push({ name, ...info });
        return flavor === "chrome" ? Promise.resolve() : undefined;
      },
      onAlarm: { addListener: (f) => (calls.onAlarm = f) },
    },
    idle: {
      onStateChanged: { addListener: (f) => (calls.onIdle = f) },
    },
    // Firefox-only: the popup warns when private browsing access is missing.
    extension: { isAllowedIncognitoAccess: () => Promise.resolve(true) },
  };

  const sandbox = {
    [flavor]: api,
    console: { log() {}, error() {}, warn() {} },
    // Timers are recorded, not run: a test that wants one to fire calls
    // its fn itself, so reconnect scheduling can be asserted without waiting.
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      calls.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = calls.timers.indexOf(t);
      if (i !== -1) calls.timers.splice(i, 1);
    },
    crypto: { randomUUID: () => "test-uuid" },
    URL,
    Promise,
    ...extraGlobals,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });

  return { sandbox, calls, nativePort };
}

// fireTimers runs every timer the script has set so far, once, in order.
// Timers set while running are left for the next call.
export function fireTimers(calls) {
  const due = calls.timers.splice(0);
  for (const { fn } of due) fn();
  return due.length;
}

// plain copies a value out of the sandbox realm. Objects built inside the vm
// carry that realm's Object.prototype, which deep-equality treats as a
// difference even when every field matches, so results cross the boundary
// through here before being compared.
export function plain(v) {
  return v === null || typeof v !== "object" ? v : { ...v };
}

// connectPopup simulates the popup opening and returns the messages it is sent.
export function connectPopup(calls) {
  const port = {
    name: "popup",
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage: (m) => calls.toPopup.push(m),
  };
  calls.onConnect(port);
  return port;
}

// sendCommand delivers a popup command and normalizes the two reply styles
// (Chrome's sendResponse callback vs Firefox's returned promise) into one
// promise, so tests can await either.
export function sendCommand(calls, message) {
  let resolveVia;
  const viaCallback = new Promise((r) => (resolveVia = r));
  const returned = calls.onMessage(message, {}, (response) => resolveVia(response));
  if (returned && typeof returned.then === "function") return returned;
  if (returned === true) return viaCallback; // Chrome: reply comes later
  return Promise.resolve(undefined);
}
