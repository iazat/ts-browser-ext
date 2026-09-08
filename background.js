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

// stopBrowserProxy hands browsing back to a direct connection without telling
// the backend anything. Use it when the backend is itself the one reporting
// that it is not routing: sending "down" there would switch off a profile the
// user never switched off, and it would stay off across restarts.
function stopBrowserProxy() {
  proxyEnabled = false;
  lastProxyPort = 0;
  clearBrowserProxy();
}

// proxyWanted is what the user last asked of the toggle: true, false, or null
// when they have not touched it since this script started. Null is the normal
// state after a wake from sleep, and it is why the backend gets the last word
// then.
let proxyWanted = null;

// syncProxyToBackend routes the browser through the native proxy exactly while
// the backend says it is running, and hands browsing back the rest of the time.
//
// The backend is the side that remembers. Its preferences are on disk, so it
// comes back from a restart connected or switched off, whichever the user left
// it; everything this script knows lives in a worker the browser throws away.
// So after a wake the browser's proxy follows the backend rather than the other
// way round — unless the user has just asked for a state the backend has not
// reached yet, where the request is the newer fact.
function syncProxyToBackend(status) {
  const running = !!(status && status.running);
  if (running) {
    if (
      proxyWanted !== false &&
      nativeProxyPort &&
      (!proxyEnabled || lastProxyPort !== nativeProxyPort)
    ) {
      console.log("Backend is running; routing the browser through it");
      setProxy(nativeProxyPort);
    }
    return;
  }
  if (proxyEnabled && proxyWanted !== true) {
    console.log("Backend is not routing; handing browsing back to direct");
    stopBrowserProxy();
  }
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
  stopBrowserProxy();
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
  } else {
    reconnectNow("popup opened");
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
    // A backend that has answered before is installed, so a dead port here
    // means it is being restarted, not missing. Give up on that story once the
    // reconnects keep failing, because by then it may really be gone — someone
    // ran --uninstall, or the browser cannot launch it any more.
    if (hostSeen && failedConnects <= 3) {
      console.log("sendPopupStatus... reconnecting to the native host");
      sendToPopup({ reconnecting: true });
      return;
    }
    console.log("sendPopupStatus... no nmPort");
    sendToPopup({
      installCmd:
        "go run github.com/iazat/ts-browser-ext@latest --install=" +
        browserByte() +
        chrome.runtime.id,
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

// Reconnect policy for the native messaging host.
//
// The host is a child process of the browser and dies with the port that
// carries it. On a Mac that happens every time the machine sleeps: the browser
// suspends, the worker running this script is discarded, and the backend goes
// with it. Coming back has to be automatic, because the alternative is what
// this did before — wait for someone to open the popup, which is to say wait
// for the user to find out the extension has been dead since the lid closed.
const retryMinMs = 1000;
const retryMaxMs = 30000;
let retryDelayMs = retryMinMs;
let retryTimer = null;

// failedConnects counts disconnects since the last message from a host. It
// separates "the machine just woke up" from "no backend is installed", which
// look identical from here and call for opposite things to be said.
let failedConnects = 0;

// reconnectAlarmName names an alarm rather than a timer because a timer only
// exists while this script does. The browser discards the worker when it goes
// idle and suspends everything when the machine sleeps; an alarm is held by
// the browser, which starts the worker again to deliver it. That is the
// difference between recovering by itself and waiting to be noticed.
const reconnectAlarmName = "reconnect-native-host";

// hostSeen records that a backend has answered in this profile at least once.
// Until then a dead port means it was never installed, and the popup prints the
// command that installs it. After it, the same dead port almost always means
// the machine woke up a second ago — and telling people to install what they
// already have is how an ordinary reconnect reads as a broken extension.
let hostSeen = false;

function rememberHostSeen() {
  if (hostSeen) {
    return;
  }
  hostSeen = true;
  chrome.storage.local.set({ hostSeen: true });
}

// connectingSince guards against starting a second backend on top of one that
// has not answered yet. Several things can ask for a reconnect at once — an
// alarm landing on top of a retry, someone opening the popup — and every
// connectNative starts another process. It expires, because a host that never
// answers at all still has to be retried.
const connectStallMs = 5000;
let connectingSince = 0;

function scheduleReconnect() {
  if (retryTimer !== null) {
    return; // an attempt is already pending
  }
  console.log("Reconnecting to the native host in " + retryDelayMs + "ms");
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectToNativeHost();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, retryMaxMs);
}

// reconnectNow tries again straight away, dropping whatever backoff has built
// up. Its callers are the events that mean the machine is back and someone is
// about to browse; sitting out a 30 second delay then is pure lost time.
function reconnectNow(why) {
  if (!deadPort) {
    return;
  }
  console.log("Reconnecting to the native host now: " + why);
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = retryMinMs;
  connectToNativeHost();
}

connectToNativeHost();

function connectToNativeHost() {
  if (nmPort && !deadPort) {
    return;
  }
  if (connectingSince && Date.now() - connectingSince < connectStallMs) {
    console.log("A native host is already starting; not starting another");
    return;
  }
  connectingSince = Date.now();
  console.log("Connecting to native messaging host...");
  nmPort = chrome.runtime.connectNative("io.github.iazat.tailext.chrome");

  nmPort.onDisconnect.addListener(() => {
    deadPort = true;
    connectingSince = 0;
    nativeProxyPort = 0; // the host is gone, and so is the port it was listening on
    // The next host is a new process with no tsnet running in it, so it needs
    // the init this one already had. Leaving this set made reconnecting worse
    // than staying down: the extension pointed the browser at a backend that
    // had never been told to start, and every page load failed against a proxy
    // with no tailnet behind it.
    didInit = false;
    failedConnects++;
    setPopupIcon("need-install");
    disableProxy();
    const error = chrome.runtime.lastError;
    if (error) {
      console.error("Connection failed:", error.message);
      portError = error.message;
    } else {
      console.error("Disconnected from native host");
    }
    // Retry either way. A host that exits by itself reports no lastError at
    // all, and that is exactly the disconnect a sleeping machine produces —
    // the old code retried only the other kind, so a wake left the extension
    // down until something else happened to restart this script.
    scheduleReconnect();
    sendPopupStatus();
  });
  nmPort.onMessage.addListener((message) => {
    console.log("got message: " + JSON.stringify(message));
    if (deadPort) {
      console.log("connected to native backend");
      deadPort = false;
    }
    connectingSince = 0;
    retryDelayMs = retryMinMs;
    failedConnects = 0;
    rememberHostSeen();
    if (message.procRunning) {
      if (message.procRunning.port) {
        nativeProxyPort = message.procRunning.port;
        // Whether to route the browser through it is the next status message's
        // call, not this one's: the backend's preferences are on disk and
        // remember whether this profile was left connected, while a worker that
        // has just started remembers nothing. Routing on sight is what switched
        // the tailnet back on for people who had switched it off, and pointed
        // the browser into a backend that was still stopped.
        if (proxyWanted === true) {
          setProxy(message.procRunning.port);
        }
      } else if (message.procRunning.error) {
        console.log(
          "procRunning error from backend: " + message.procRunning.error
        );
        disableProxy();
      }
    }
    if (message.init && message.init.error) {
      console.log("init error from backend: " + message.init.error);
      disableProxy();
    }
    if (message.status) {
      lastStatus = message.status;
      syncProxyToBackend(message.status);
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

chrome.storage.local.get(["profileId", "hostSeen"], (result) => {
  hostSeen = hostSeen || !!result.hostSeen;
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
    proxyWanted = proxyEnabled; // an explicit request outranks the backend
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

// Everything that means "the machine is back".
//
// A wake from sleep arrives as some combination of these: this script is
// started fresh, idle flips back to active, and any alarm that came due while
// the machine was off is delivered late. Each one does nothing unless the port
// is actually dead, so they cost nothing while the backend is healthy.
chrome.alarms.create(reconnectAlarmName, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === reconnectAlarmName) {
    reconnectNow("alarm");
  }
});

chrome.idle.onStateChanged.addListener((state) => {
  // "active" is the machine coming back — from sleep, from the lock screen, or
  // from a coffee. It is the earliest word we get that someone is about to
  // load a page, which is when a dead backend starts to matter.
  if (state === "active") {
    reconnectNow("idle state " + state);
  }
});

chrome.runtime.onStartup.addListener(() => {
  reconnectNow("browser startup");
});
