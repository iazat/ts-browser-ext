let proxyEnabled = false;

// setPopupIcon sets the icon. It takes either a boolean (for online/offline)
// or the base name of the png file.
let lastIconBase = null;

function setPopupIcon(base) {
  if (typeof base === "boolean") {
    base = base ? "online" : "offline";
  }
  if (base === lastIconBase) {
    return; // the toolbar is already showing it
  }
  lastIconBase = base;
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

// isStopped reports whether the backend says this profile is switched off, as
// against still on its way up. The backend reports the state in an error
// string; popup.js reads the same shape to decide what to print.
function isStopped(status) {
  return !!status && status.error === "State: Stopped";
}

// syncProxyToBackend keeps the browser's proxy in step with the backend.
//
// The backend is the side that remembers. Its preferences are on disk, so it
// comes back from a restart connected or switched off, whichever the user left
// it; everything this script knows lives in a worker the browser throws away.
// So after a wake the browser's proxy follows the backend rather than the other
// way round — unless the user has just asked for a state the backend has not
// reached yet, where the request is the newer fact.
//
// Stopped is the only state that means direct browsing. Every other state
// short of running — NoState, Starting, waiting on device approval — is a
// connection coming up, and two things go wrong if the browser is left out of
// the proxy through those. The browser keeps a proxy setting across a restart
// of this script, so it goes on addressing the port the last backend listened
// on, which nothing answers any more; and where an exit node is configured,
// whatever does get through leaves from this machine's own address instead,
// seconds at a time and invisibly afterwards. Pointing at the new backend
// fails closed on both counts: it refuses to dial until dialling is safe (see
// safeToDial in the Go host).
function syncProxyToBackend(status) {
  if (isStopped(status)) {
    if (proxyEnabled && proxyWanted !== true) {
      console.log("Backend is stopped; handing browsing back to direct");
      stopBrowserProxy();
    }
    return;
  }
  if (proxyWanted === false || !nativeProxyPort) {
    return;
  }
  if (!proxyEnabled || lastProxyPort !== nativeProxyPort) {
    console.log(
      status && status.running
        ? "Backend is running; routing the browser through it"
        : "Backend is coming up; routing the browser through it rather than " +
            "leaving it on a port nothing is listening on"
    );
    setProxy(nativeProxyPort);
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

// Every popup that is currently open. It used to be a single port, so opening
// the panel while popup.html was also open in a tab left the tab frozen on
// whatever it had rendered first — it went on showing "None" for an exit node
// that had since been chosen, with nothing to suggest it was stale.
let popupPorts = new Set();

browser.runtime.onConnect.addListener((port) => {
  if (port.name != "popup") {
    return;
  }
  popupPorts.add(port);

  console.log("Popup connected");

  port.onMessage.addListener((msg) => {
    console.log("Message from popup:", msg);
  });

  port.onDisconnect.addListener(() => {
    console.log("Popup disconnected");
    popupPorts.delete(port);
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
// browser: "F" here, and "C" in the Chrome copy of this file.
//
// The two extensions are separate copies, so which browser this one runs in is
// settled when the file is written. Asking the environment instead is what used
// to get it wrong: Chrome now defines `browser` as well, and a user agent can
// claim anything. A wrong byte prints a command that registers the native host
// for the browser that is not running, and the popup keeps asking for an
// install that was just done.
function browserByte() {
  return "F";
}

function sendPopupStatus() {
  // firefox requires that extensions settings proxies have private browsing access
  browser.extension
    .isAllowedIncognitoAccess()
    .then((isAllowed) => {
      if (!isAllowed) {
        sendToPopup({ needsIncognitoPermission: true });
      }
    })
    .catch((error) => {
      // Same shape as the alarm above: an unheld promise rejects into the
      // extension's error list rather than a log line anyone can read.
      console.error("checking private browsing access:", error && error.message);
    });

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
        browser.runtime.id,
    });
    return;
  }
  setPopupIcon(proxyEnabled ? "online" : "offline");

  sendToPopup({ status: lastStatus });
}

// rememberStatus keeps the last status where a popup can read it without this
// script being awake at all.
//
// The browser discards this worker, and the backend — its child process — dies
// with it, so opening the popup can mean waiting out a new backend starting
// Tailscale from cold. The popup has no way to shorten that wait, but it does
// not have to spend it blank: storage is readable from the popup directly, so
// it can paint what was last true and keep its spinner until this script
// confirms or corrects it.
function rememberStatus(status) {
  browser.storage.local.set({ lastStatus: status }).catch((error) => {
    // Only costs the next popup its head start.
    console.error("caching the last status:", error && error.message);
  });
}

function sendToPopup(v) {
  for (const port of popupPorts) {
    try {
      port.postMessage(v);
    } catch (error) {
      // A popup that closed between the check and the post. Nothing to do
      // about it, and nothing worth telling anyone.
      popupPorts.delete(port);
    }
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
  browser.storage.local.set({ hostSeen: true }).catch((error) => {
    // Only costs the popup its "Reconnecting…" wording on a later start.
    console.error("remembering that the backend is installed:", error && error.message);
    hostSeen = false;
  });
}

// connectingSince guards against starting a second backend on top of one that
// has not answered yet. Several things can ask for a reconnect at once — an
// alarm landing on top of a retry, someone opening the popup — and every
// connectNative starts another process. It expires, because a host that never
// answers at all still has to be retried.
const connectStallMs = 5000;
let connectingSince = 0;

// Keepalive for the worker this script runs in.
//
// The browser discards an idle worker after about thirty seconds, and the
// native host is its child: the backend dies with it, so the next click pays
// for a whole new process starting Tailscale from cold — seconds of a popup
// that just spins. Traffic in a message resets that idle timer, so while a
// backend is connected we ask it for a status well inside the window. The
// reply is what actually keeps the worker alive; the question is only how to
// provoke one, and a status refreshes what the popup will show anyway.
//
// This is a deliberate trade: a resident worker for as long as the backend is
// up. That backend is a running process holding the tailnet either way, and
// the alternative is a VPN that has to be restarted every time it is looked
// at.
const keepaliveMs = 20000;
let keepaliveTimer = null;

function scheduleKeepalive() {
  if (keepaliveTimer !== null || deadPort) {
    return;
  }
  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    if (deadPort || !nmPort) {
      return;
    }
    nmPort.postMessage({ cmd: "get-status" });
    scheduleKeepalive();
  }, keepaliveMs);
}

function stopKeepalive() {
  if (keepaliveTimer !== null) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
}

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
  nmPort = browser.runtime.connectNative("io.github.iazat.tailext.firefox");

  nmPort.onDisconnect.addListener(() => {
    deadPort = true;
    connectingSince = 0;
    stopKeepalive();
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
    const error = browser.runtime.lastError;
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
    scheduleKeepalive();
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
      rememberStatus(message.status);
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
let profileReadPending = false;
const profileRetryMs = 1000;

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
  if (!profileID) {
    // Nothing to init with yet. Every message from a backend is another chance
    // at a read that storage refused earlier, and one arrives at least every
    // keepalive — so a worker cannot get stuck here for the rest of its life.
    loadProfile();
    return;
  }
  if (didInit || deadPort) {
    return;
  }
  nmPort.postMessage({ cmd: "init", initID: profileID });
  didInit = true;
}

// The profile id names the tsnet state directory, so it has to come back the
// same on every start: a different one is a different machine on the tailnet,
// logged out, with the old one's state stranded on disk. It lives in storage,
// and storage does refuse to answer sometimes — "No SW", when the browser is
// tearing this worker down around the call — handing back nothing at all.
//
// Reading a field off that nothing threw, and everything downstream went with
// it: the init the backend needs before it starts Tailscale at all never
// happened, so no status ever arrived, and the popup sat with its state line
// blank over a backend that had been told to do nothing. So a refusal is now
// something to ask again about, never something to invent an id over.
function loadProfile() {
  if (profileID || profileReadPending) {
    return;
  }
  profileReadPending = true;
  browser.storage.local
    .get(["profileId", "hostSeen"])
    .then((result) => {
      profileReadPending = false;
      if (!result) {
        throw new Error("storage answered with nothing");
      }
      hostSeen = hostSeen || !!result.hostSeen;
      if (result.profileId) {
        console.log("Profile ID already exists:", result.profileId);
        profileID = result.profileId;
        maybeSendInit();
        return;
      }
      const profileId = crypto.randomUUID();
      // An id that did not stick is worse than none: the next start would make
      // another one, and the tailnet would see a new machine each time.
      return browser.storage.local.set({ profileId }).then(() => {
        console.log("Generated profile ID:", profileId);
        profileID = profileId;
        maybeSendInit();
      });
    })
    .catch((error) => {
      profileReadPending = false;
      console.error("reading the profile from storage:", error && error.message);
      setTimeout(loadProfile, profileRetryMs);
    });
}

loadProfile();

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
    proxyWanted = proxyEnabled; // an explicit request outranks the backend
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

// Everything that means "the machine is back".
//
// A wake from sleep arrives as some combination of these: this script is
// started fresh, idle flips back to active, and any alarm that came due while
// the machine was off is delivered late. Each one does nothing unless the port
// is actually dead, so they cost nothing while the backend is healthy.
// The answer is a promise on Chrome and nothing at all on Firefox, and a
// promise nobody holds rejects loudly — "No SW", when the browser is
// discarding this worker around the call — into the extension's error list,
// with a stack pointing at the top of this file and no hint of which line.
// Resolve first, so either shape ends in the same handler.
Promise.resolve(browser.alarms.create(reconnectAlarmName, { periodInMinutes: 1 })).catch(
  (error) => {
    console.error("registering the reconnect alarm:", error && error.message);
  }
);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === reconnectAlarmName) {
    reconnectNow("alarm");
  }
});

browser.idle.onStateChanged.addListener((state) => {
  // "active" is the machine coming back — from sleep, from the lock screen, or
  // from a coffee. It is the earliest word we get that someone is about to
  // load a page, which is when a dead backend starts to matter.
  if (state === "active") {
    reconnectNow("idle state " + state);
  }
});

browser.runtime.onStartup.addListener(() => {
  reconnectNow("browser startup");
});
