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
export function loadBackground(file, flavor) {
  const calls = {
    proxyListeners: [], // handlers currently registered on proxy.onRequest
    removeMisses: 0, //    removeListener calls that matched no handler
    proxyModes: [], //     modes passed to proxy.settings.set, in order
    toNativeHost: [], //   messages posted to the native messaging port
    toPopup: [], //        messages posted down the popup port
    icons: [], //          icon base names the script asked for
  };

  const nativePort = {
    postMessage: (m) => calls.toNativeHost.push(m),
    onDisconnect: { addListener: (f) => (calls.onNativeDisconnect = f) },
    onMessage: { addListener: (f) => (calls.onNativeMessage = f) },
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
      connectNative: (name) => ((calls.nativeHostName = name), nativePort),
      onConnect: { addListener: (f) => (calls.onConnect = f) },
      onMessage: { addListener: (f) => (calls.onMessage = f) },
    },
    storage: {
      local: {
        get: (key, cb) => respond(cb, { profileId: "test-profile-id" }),
        set: (items, cb) => respond(cb, undefined),
      },
    },
    // Firefox-only: the popup warns when private browsing access is missing.
    extension: { isAllowedIncognitoAccess: () => Promise.resolve(true) },
  };

  const sandbox = {
    [flavor]: api,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 0,
    crypto: { randomUUID: () => "test-uuid" },
    URL,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });

  return { sandbox, calls, nativePort };
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
