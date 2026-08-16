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

  browser.action.setIcon({ path }).catch((error) => {
    console.error("Error setting icon to " + base + ":", error.message);
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
// disabling the proxy (or losing the native host) leaves the onRequest handler
// pointing at a dead 127.0.0.1:<port>, breaking all browsing.
// See tailscale/ts-browser-ext#18.
function clearBrowserProxy() {
  if (activeProxyHandler) {
    browser.proxy.onRequest.removeListener(activeProxyHandler);
    activeProxyHandler = null;
  }
  browser.proxy.settings
    .set({
      value: {
        mode: "direct",
      },
      scope: "regular",
    })
    .then(() => {
      console.log("Browser proxy reset to direct.");
    })
    .catch((error) => {
      console.error("Error resetting proxy to direct:", error.message);
    });
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

browser.runtime.onConnect.addListener((port) => {
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

// browserByte returns either "F" for Firefox or "C" for chrome.
// Other browsers return "?".
function browserByte() {
  if (typeof browser !== "undefined") {
    return "F";
  }
  return "?";
}

function sendPopupStatus() {
  // firefox requires that extensions settings proxies have private browsing access
  browser.extension.isAllowedIncognitoAccess().then(isAllowed => {
    if (!isAllowed) {
          sendToPopup({
        needsIncognitoPermission: true
      });
    }
  });

  if (deadPort) {
    setPopupIcon("need-install");
    console.log("sendPopupStatus... no nmPort");
    sendToPopup({
      installCmd:
        "go run github.com/iazat/ts-browser-ext@latest --install=" +
        browserByte() +
        browser.runtime.id,
    });
    return;
  }
  setPopupIcon(proxyEnabled ? "online" : "offline");

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

connectToNativeHost();

function connectToNativeHost() {
  if (nmPort && !deadPort) {
    return;
  }
  console.log("Connecting to native messaging host...");
  nmPort = browser.runtime.connectNative("io.github.iazat.tailext.firefox");

  nmPort.onDisconnect.addListener(() => {
    deadPort = true;
    nativeProxyPort = 0; // the host is gone, and so is the port it was listening on
    setPopupIcon("need-install");
    disableProxy();
    const error = browser.runtime.lastError;
    if (error) {
      console.error("Connection failed:", error.message);
      portError = error.message;
      setTimeout(connectToNativeHost, 1000);
    } else {
      console.error("Disconnected from native host");
    }
  });
  nmPort.onMessage.addListener((message) => {
    console.log("got message: " + JSON.stringify(message));
    if (deadPort) {
      console.log("connected to native backend");
      deadPort = false;
    }
    if (message.procRunning) {
      if (message.procRunning.port) {
        nativeProxyPort = message.procRunning.port;
        setProxy(message.procRunning.port);
      } else if (message.procRunning.errror) {
        console.log(
          "procRunning error from backend: " + message.procRunning.err
        );
        disableProxy();
      }
    }
    if (message.init && message.init.error) {
      console.log("init error from backend: " + message.init.err);
      disableProxy();
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

// activeProxyHandler is the browser.proxy.onRequest listener currently
// registered, if any. It has to be kept around so it can be handed back to
// removeListener: proxyHandler returns a fresh closure each call, so removing
// a newly built one would be a no-op and leave the old handler installed.
var activeProxyHandler = null;

function setProxy(proxyPort) {
  if (!proxyPort) {
    proxyEnabled = false;
    console.log("Disabling proxy...");
    clearBrowserProxy();
    return;
  }
  proxyEnabled = true;
  lastProxyPort = proxyPort;
  console.log("Enabling proxy at port: " + proxyPort);
  if (activeProxyHandler) {
    browser.proxy.onRequest.removeListener(activeProxyHandler);
  }
  activeProxyHandler = proxyHandler(proxyPort);
  browser.proxy.onRequest.addListener(activeProxyHandler, {
    urls: ["<all_urls>"],
  });
}

var profileID = "";
var didInit = false;

// firefox has unique behaviour where only socks proxies can handle domain resolution
function proxyHandler(port) {
  return function handleProxyRequest(requestInfo) {
    const url = new URL(requestInfo.url)

    // we need to use http for 100.100.100.100
    if (url.hostname == '100.100.100.100') {
      return { type: "http", host: "127.0.0.1", port: port };
    }

    // use socks for everything else
    return { type: "socks", host: "127.0.0.1", port: port, proxyDNS: true, bypassList: ["localhost", "127.*"] };
  }
}

function maybeSendInit() {
  if (!profileID || didInit || deadPort) {
    return;
  }
  nmPort.postMessage({ cmd: "init", initID: profileID });
  didInit = true;
}

browser.storage.local.get("profileId").then((result) => {
  if (!result.profileId) {
    const profileId = crypto.randomUUID();
    browser.storage.local.set({ profileId }).then(() => {
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
browser.runtime.onMessage.addListener((message, sender) => {
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
    let response;
    if (proxyEnabled) {
      console.log("bg: Enabling proxy");
      enableProxy();
      response = { status: lastStatus };
    } else {
      console.log("bg: Disabling proxy");
      disableProxy();
      response = { status: "Disconnected" };
    }
    setPopupIcon(proxyEnabled);
    return Promise.resolve(response);
  }
});
