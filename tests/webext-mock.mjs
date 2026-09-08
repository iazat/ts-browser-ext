// A minimal stand-in for the WebExtension APIs that background.js touches, so
// the two background scripts can be exercised outside a browser.
//
// Chrome and Firefox differ in how they answer: Chrome takes a callback,
// Firefox returns a promise. The mock supports both from one implementation,
// so the same suite can drive either copy of the extension.
import fs from "node:fs";
import vm from "node:vm";

// Answers the way the browser does: never in the same turn. A mock that called
// its callback synchronously made storage look like a local variable, and the
// extension read the answer before it could possibly have arrived — which is
// exactly the bug that shipped, where a popup was told to install a backend
// that had been installed for months because the read had not landed yet.
function respond(cb, value) {
  if (typeof cb === "function") {
    queueMicrotask(() => cb(value));
    return undefined;
  }
  return Promise.resolve(value);
}

// refuse answers the way the browser does when an extension API call cannot be
// served — "No SW", when the worker is being torn down around it. Chrome hands
// the callback nothing and sets lastError; Firefox rejects. Both have been seen
// in the wild against storage, and reading a field off that nothing threw.
function refuse(cb, api, message) {
  if (typeof cb === "function") {
    queueMicrotask(() => {
      api.runtime.lastError = { message };
      try {
        cb(undefined);
      } finally {
        api.runtime.lastError = null;
      }
    });
    return undefined;
  }
  return Promise.reject(new Error(message));
}

// loadBackground evaluates a background.js in a fresh sandbox and returns the
// sandbox plus a record of everything the script did to the browser.
//
// `flavor` picks which global the script expects: "chrome" or "browser".
// `extraGlobals` adds to the sandbox, so a test can hand the script an
// environment that lies about which browser it is running in.
// `opts.storage` seeds storage.local, so a test can start a script the way a
// second service worker starts: with whatever the first one wrote still there.
// `opts.storageFailures` and `opts.storageWriteFailures` make that many reads,
// or writes, refuse before any of them work. `opts.alarmsFail` makes alarm
// registration reject, the way it does when the browser is discarding the
// worker around the call.
export function loadBackground(file, flavor, extraGlobals = {}, opts = {}) {
  const calls = {
    proxyListeners: [], // handlers currently registered on proxy.onRequest
    removeMisses: 0, //    removeListener calls that matched no handler
    proxyModes: [], //     modes passed to proxy.settings.set, in order
    toNativeHost: [], //   messages posted to the native messaging port
    toPopup: [], //        messages posted down the popup port
    icons: [], //          icon base names the script asked for
    nativeConnects: 0, //  calls to connectNative, i.e. hosts started
    nativePorts: [], //    one per connectNative, oldest first
    errors: [], //         everything the script reported through console.error
    alarmsCreated: [], //  alarms the script asked the browser to keep
    timers: [], //         pending setTimeout callbacks, fired by runTimers
    // `opts.storage` replaces the seed rather than adding to it, so a test can
    // start from a profile that has never stored anything.
    storage: opts.storage ? { ...opts.storage } : { profileId: "test-profile-id" },
    storageFailures: opts.storageFailures || 0, //           reads still to refuse
    storageWriteFailures: opts.storageWriteFailures || 0, //  writes still to refuse
    uuidsMade: 0, //       ids handed to the script, to keep them distinct
  };

  // Each connectNative answers with its own port, as the browser does. Handing
  // out one shared object hid a superseded port whose listeners went on
  // writing into the extension's state after it had moved to another host.
  function makeNativePort() {
    const port = {
      disconnected: false,
      sent: [],
      postMessage: (m) => (port.sent.push(m), calls.toNativeHost.push(m)),
      disconnect: () => (port.disconnected = true),
      onDisconnect: {
        addListener: (f) => {
          port.fireDisconnect = f;
          calls.onNativeDisconnect = f; // the latest port is the live one
        },
      },
      onMessage: {
        addListener: (f) => {
          port.deliver = f;
          calls.onNativeMessage = f;
        },
      },
    };
    calls.nativePorts.push(port);
    return port;
  }

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
      connectNative: (name) => (
        (calls.nativeHostName = name), calls.nativeConnects++, makeNativePort()
      ),
      onConnect: { addListener: (f) => (calls.onConnect = f) },
      onMessage: { addListener: (f) => (calls.onMessage = f) },
      onStartup: { addListener: (f) => (calls.onStartup = f) },
    },
    storage: {
      local: {
        get: (key, cb) =>
          calls.storageFailures-- > 0
            ? refuse(cb, api, "No SW")
            : respond(cb, { ...calls.storage }),
        set: (items, cb) =>
          calls.storageWriteFailures-- > 0
            ? refuse(cb, api, "No SW")
            : (Object.assign(calls.storage, items), respond(cb, undefined)),
      },
    },
    // The two ways the browser can start the script back up after the machine
    // has been away: a due alarm, and the machine going active again.
    alarms: {
      create: (name, info) => {
        calls.alarmsCreated.push({ name, ...info });
        return opts.alarmsFail
          ? Promise.reject(new Error("No SW"))
          : Promise.resolve();
      },
      onAlarm: { addListener: (f) => (calls.onAlarm = f) },
    },
    idle: {
      onStateChanged: { addListener: (f) => (calls.onIdleStateChanged = f) },
    },
    // Firefox-only: the popup warns when private browsing access is missing.
    extension: { isAllowedIncognitoAccess: () => Promise.resolve(true) },
  };

  const sandbox = {
    [flavor]: api,
    console: {
      log() {},
      warn() {},
      error: (...args) => calls.errors.push(args.map(String).join(" ")),
    },
    // Timers are collected rather than run, so a test decides when the retry
    // it scheduled happens. Ids start at 1: 0 is falsy, and the script tells
    // "no timer pending" from "timer pending" by the value it holds.
    setTimeout: (fn, ms) => calls.timers.push({ fn, ms }),
    clearTimeout: (id) => {
      if (id) calls.timers[id - 1] = null;
    },
    // Distinct each time, as a real one is: a test can then tell the id that
    // was kept from one that was generated and thrown away.
    crypto: { randomUUID: () => `test-uuid-${++calls.uuidsMade}` },
    URL,
    Promise,
    ...extraGlobals,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });

  return { sandbox, calls };
}

// runTimers fires every setTimeout the script has pending, oldest first, the
// way the browser would once the delay is up.
export function runTimers(calls) {
  const due = calls.timers;
  calls.timers = [];
  for (const t of due) {
    if (t) t.fn();
  }
  return due.filter(Boolean).length;
}

// fireAlarm delivers an alarm, as the browser does — starting the script again
// first, if it had been discarded.
export function fireAlarm(calls, name) {
  calls.onAlarm({ name });
}

// goIdle delivers an idle state change. "active" is the machine coming back.
export function goIdle(calls, state) {
  calls.onIdleStateChanged(state);
}

// plain copies a value out of the sandbox realm. Objects built inside the vm
// carry that realm's Object.prototype, which deep-equality treats as a
// difference even when every field matches, so results cross the boundary
// through here before being compared.
export function plain(v) {
  return v === null || typeof v !== "object" ? v : { ...v };
}

// connectPopup simulates a popup opening. The returned port collects what that
// particular popup was sent in `received`, so a test can tell two open popups
// apart — popup.html can be open in a tab and in the toolbar panel at once.
export function connectPopup(calls) {
  const received = [];
  const port = {
    name: "popup",
    received,
    onMessage: { addListener() {} },
    onDisconnect: { addListener: (f) => (port.fireDisconnect = f) },
    postMessage: (m) => (received.push(m), calls.toPopup.push(m)),
  };
  calls.onConnect(port);
  return port;
}

// closePopup is that popup being closed.
export function closePopup(port) {
  if (port.fireDisconnect) port.fireDisconnect();
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
