let proxyEnabled = false;

// setPopupIcon sets the icon. It takes either a boolean (for online/offline)
// or the base name of the png file.
function setPopupIcon(base) {
  if (typeof base === "boolean") {
    base = base ? "online" : "offline";
  }
  // Hand the browser the whole set rather than one file. The toolbar draws at
  // 16px, and letting it downscale a 128px drawing with nine elements in it
  // produces a smudge; the 16px artwork in the set is simplified for that.
  const path = {
    16: `icons/${base}-16.png`,
    32: `icons/${base}-32.png`,
    48: `icons/${base}-48.png`,
    128: `icons/${base}-128.png`,
  };
  console.log("set icon to: " + base);

  chrome.action.setIcon({ path }, () => {
    if (chrome.runtime.lastError) {
      console.error(
        "Error setting icon to " + base + ":",
        chrome.runtime.lastError.message
      );
    }
  });
}

function enableProxy() {
  if (deadPort) {
    console.error("Cannot enable proxy, disconnected from native host");
    return;
  }

  nmPort.postMessage({ cmd: "up" });

  // Point the browser back at the native host's proxy. Nothing else will: the
  // host reports its port once, in procRunning at startup, and answers "up"
  // with a status message. Its listener outlives a down/up cycle, so the port
  // we were told is still good.
  if (nativeProxyPort) {
    setProxy(nativeProxyPort);
  }
}

// clearBrowserProxy resets the browser's proxy back to direct. Without this,
// disabling the proxy (or losing the native host) leaves chrome.proxy pointing
// at a dead 127.0.0.1:<port>, breaking all browsing with
// ERR_PROXY_CONNECTION_FAILED. See tailscale/ts-browser-ext#18.
function clearBrowserProxy() {
  chrome.proxy.settings.set(
    { value: { mode: "direct" }, scope: "regular" },
    () => {
      if (chrome.runtime.lastError) {
        console.error(
          "Error resetting proxy to direct:",
          chrome.runtime.lastError.message
        );
      } else {
        console.log("Browser proxy reset to direct.");
      }
    }
  );
}

function disableProxy() {
  console.log("disableProxy called");
  if (nmPort && !deadPort) {
    console.log("Sending down command to native host");
    nmPort.postMessage({ cmd: "down" });
  } else {
    console.log(
      "Cannot send down command - nmPort:",
      !!nmPort,
      "deadPort:",
      deadPort
    );
  }
  proxyEnabled = false;
  lastProxyPort = 0;
  clearBrowserProxy();
  console.log(
    "Proxy disabled, proxyEnabled:",
    proxyEnabled,
    "lastProxyPort:",
    lastProxyPort
  );
}

console.log("starting ts-browser-ext");

let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name != "popup") {
    return;
  }
  popupPort = port;

  console.log("Popup connected");

  port.onMessage.addListener((msg) => {
    console.log("Message from popup:", msg);
  });

  port.onDisconnect.addListener(() => {
    console.log("Popup disconnected");
    popupPort = null;
  });

  sendPopupStatus();

  // Pull a fresh status from the native host so the popup reflects any state
  // change (e.g. login completing) that happened while it was closed.
  if (nmPort && !deadPort) {
    nmPort.postMessage({ cmd: "get-status" });
  }
});

// browserByte returns the prefix the backend's --install flag takes for this
// browser: "C" here, and "F" in the Firefox copy of this file.
//
// The two extensions are separate copies, so which browser this one runs in is
// settled when the file is written. Asking the environment instead is what used
// to get it wrong: Chrome now defines `browser` as well, and a user agent can
// claim anything. A wrong byte prints a command that registers the native host
// for the browser that is not running, and the popup keeps asking for an
// install that was just done.
function browserByte() {
  return "C";
}

function sendPopupStatus() {
  if (deadPort) {
    setPopupIcon("need-install");
    console.log("sendPopupStatus... no nmPort");
    // A host that answered earlier in this worker's life and then went away
    // is being restarted, not missing: asking for an install there sends the
    // user to re-run a command that changes nothing. Only a host that has
    // never answered gets the install prompt, with the browser's reason for
    // the failure next to it, since "not found" and "exited" want different
    // fixes.
    if (everConnected) {
      sendToPopup({ reconnecting: true, error: portError });
      return;
    }
    sendToPopup({
      installCmd:
        "go run github.com/iazat/ts-browser-ext@latest --install=" +
        browserByte() +
        chrome.runtime.id,
      error: portError,
    });
    return;
  }
  setPopupIcon(proxyEnabled ? "online" : "offline");

  if (lastInitError) {
    sendToPopup({ status: { error: "Backend failed to start: " + lastInitError } });
    return;
  }
  sendToPopup({ status: lastStatus });
}

function sendToPopup(v) {
  if (popupPort) {
    popupPort.postMessage(v);
  }
}

let nmPort = null; // even non-null if lacking permission
let deadPort = true;
let portError = null;
// everConnected records that a native host answered at least once since this
// worker started, which is what tells a restart apart from a missing install.
let everConnected = false;
// lastInitError is the backend's reason for failing to start tsnet, shown in
// the popup until a host starts cleanly.
let lastInitError = null;

// Reconnection is retried with backoff rather than at a fixed second. A host
// that is missing fails instantly and would otherwise be tried every second
// for as long as the browser runs; one that is crashing on start gets the same
// treatment. Any answer from a host resets the delay.
const reconnectDelayMin = 1000;
const reconnectDelayMax = 30000;
let reconnectDelay = reconnectDelayMin;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }
  console.log("Reconnecting to native host in " + reconnectDelay + "ms");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToNativeHost();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, reconnectDelayMax);
}

connectToNativeHost();

// The port to the native host is what keeps this service worker alive
// (Chrome 105+). When the host goes away the port closes, and unless it is
// reopened the worker is shut down after its idle timer — with the browser's
// proxy setting, which persists on its own, still pointing at the dead port.
// Chrome's own advice is to reconnect from onDisconnect; these two events
// cover the worker being started fresh, at browser launch and after an
// update, when there is no onDisconnect to reconnect from.
chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started");
  connectToNativeHost();
});
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed or updated");
  connectToNativeHost();
});

function connectToNativeHost() {
  if (nmPort && !deadPort) {
    return;
  }
  console.log("Connecting to native messaging host...");
  const port = chrome.runtime.connectNative("io.github.iazat.tailext.chrome");
  nmPort = port;

  port.onDisconnect.addListener(() => {
    if (port !== nmPort) {
      // A port we already replaced; its news is stale.
      return;
    }
    const error = chrome.runtime.lastError;
    deadPort = true;
    nativeProxyPort = 0; // the host is gone, and so is the port it was listening on
    // Whatever replaces it is a fresh process that knows nothing: it has to
    // be sent init again, and the status we were holding is that of a host
    // that no longer exists. Leaving didInit set here is how a restarted
    // backend used to sit forever without tsnet, the popup reading
    // "Connecting…" and every page failing, until the extension was reloaded.
    didInit = false;
    lastStatus = {};
    setPopupIcon("need-install");
    disableProxy();
    if (error) {
      console.error("Connection failed:", error.message);
      portError = error.message;
    } else {
      console.error("Disconnected from native host");
      portError = null;
    }
    sendPopupStatus();
    // Reconnect whether or not the browser reported a reason. A host that
    // exited cleanly needs replacing just as much as one that crashed, and
    // the old rule of only retrying on an error left the browser without a
    // backend after the former.
    scheduleReconnect();
  });
  port.onMessage.addListener((message) => {
    console.log("got message: " + JSON.stringify(message));
    if (deadPort) {
      console.log("connected to native backend");
      deadPort = false;
    }
    everConnected = true;
    portError = null;
    reconnectDelay = reconnectDelayMin;
    if (message.procRunning) {
      if (message.procRunning.port) {
        nativeProxyPort = message.procRunning.port;
        setProxy(message.procRunning.port);
      } else if (message.procRunning.error) {
        console.log(
          "procRunning error from backend: " + message.procRunning.error
        );
        disableProxy();
      }
    }
    if (message.init) {
      if (message.init.error) {
        console.log("init error from backend: " + message.init.error);
        lastInitError = message.init.error;
        disableProxy();
      } else {
        lastInitError = null;
      }
    }
    if (message.cmdError) {
      // The backend carries on after a failed command; the status that
      // follows shows where things stand. Worth a line in the console.
      console.error(
        "backend could not run " + message.cmdError.cmd + ": " + message.cmdError.error
      );
    }
    if (message.status) {
      lastStatus = message.status;
    }
    maybeSendInit();
    sendPopupStatus();
  });
}

var lastProxyPort = 0;
var lastStatus = {}; // last Go status

// nativeProxyPort is the port the native host's proxy listens on, as reported
// in procRunning. Unlike lastProxyPort it survives disableProxy(), because the
// host keeps listening after "down" — only losing the host itself invalidates
// it.
var nativeProxyPort = 0;

function setProxy(proxyPort) {
  if (proxyPort) {
    proxyEnabled = true;
    lastProxyPort = proxyPort;
    console.log("Enabling proxy at port: " + proxyPort);
  } else {
    proxyEnabled = false;
    console.log("Disabling proxy...");
    chrome.proxy.settings.set(
      {
        value: {
          mode: "direct",
        },
        scope: "regular",
      },
      () => {
        console.log("Proxy disabled.");
      }
    );
    return;
  }
  chrome.proxy.settings.set(
    {
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme: "http",
            host: "127.0.0.1",
            port: proxyPort,
          },
          bypassList: ["localhost", "127.*"],
        },
      },
      scope: "regular",
    },
    () => {
      console.log("Proxy enabled: 127.0.0.1:" + proxyPort);
    }
  );
}

var profileID = "";
var didInit = false;

function maybeSendInit() {
  if (!profileID || didInit || deadPort) {
    return;
  }
  nmPort.postMessage({ cmd: "init", initID: profileID });
  didInit = true;
}

chrome.storage.local.get("profileId", (result) => {
  if (!result.profileId) {
    const profileId = crypto.randomUUID();
    chrome.storage.local.set({ profileId }, () => {
      console.log("Generated profile ID:", profileId);
      profileID = profileId;
      maybeSendInit();
    });
  } else {
    console.log("Profile ID already exists:", result.profileId);
    profileID = result.profileId;
    maybeSendInit();
  }
});

// Listener for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("bg: Received message:", message);
  if (message.command === "setExitNode") {
    if (nmPort && !deadPort) {
      nmPort.postMessage({ cmd: "set-exit-node", exitNode: message.exitNode });
    }
    return;
  }
  if (message.command === "toggleProxy") {
    console.log("bg: toggleProxy received, current proxy=" + proxyEnabled);
    proxyEnabled = !proxyEnabled;
    if (proxyEnabled) {
      console.log("bg: Enabling proxy");
      enableProxy();
      console.log("bg: toggleProxy on, now proxy=" + proxyEnabled);
      sendResponse({ status: lastStatus });
      console.log("bg: toggleProxy on, sent status response");
    } else {
      console.log("bg: Disabling proxy");
      disableProxy();
      console.log("bg: toggleProxy off, now proxy=" + proxyEnabled);
      sendResponse({ status: "Disconnected" });
      console.log("bg: toggleProxy off, sent disconnected response");
    }
    setPopupIcon(proxyEnabled);
    return true; // Keep the message channel open for the async response
  }
});
