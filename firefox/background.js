let proxyEnabled = false;

// lastIconBase is what the toolbar is currently showing. Every status used to
// redraw it, and a status arrives for anything that happens on the tailnet:
// four PNGs fetched and decoded on the button the user is trying to click.
let lastIconBase = null;

// setPopupIcon sets the icon. It takes either a boolean (for online/offline)
// or the base name of the png file.
function setPopupIcon(base) {
  if (typeof base === "boolean") {
    base = base ? "online" : "offline";
  }
  if (base === lastIconBase) {
    return;
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

// pendingWant is a request the user made while there was no backend to hear
// it: true for on, false for off, null when nothing is owed. It is delivered
// to the next backend once that one has been sent init.
let pendingWant = null;

// proxyWanted is what the user last asked of the toggle in this worker's
// life: true, false, or null when they have not touched it. Null is the
// normal state after a restart, and it is why the backend gets the last word
// then: its switch is remembered on disk, this worker remembers nothing.
let proxyWanted = null;

// wasProxied is set when a host dies while the browser was going through it,
// and cleared once the browser is routed again or the backend says it is
// stopped. It lets the replacement host take the browser back the moment it
// has a port, rather than after it has finished starting Tailscale: with an
// exit node configured, every second on a direct connection is traffic
// leaving from this machine's own address.
let wasProxied = false;

function enableProxy() {
  if (deadPort) {
    console.log("No backend to switch on yet; remembering the request");
    pendingWant = true;
    return;
  }
  pendingWant = null;

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
// the backend anything. It is for the cases where the backend is the one
// reporting that it is not routing, or is gone: sending "down" there would
// switch off a profile the user never switched off, and that would be
// remembered.
function stopBrowserProxy() {
  proxyEnabled = false;
  lastProxyPort = 0;
  clearBrowserProxy();
}

function disableProxy() {
  console.log("disableProxy called");
  if (nmPort && !deadPort) {
    console.log("Sending down command to native host");
    nmPort.postMessage({ cmd: "down" });
    pendingWant = null;
  } else {
    console.log("No backend to switch off yet; remembering the request");
    pendingWant = false;
  }
  stopBrowserProxy();
  console.log(
    "Proxy disabled, proxyEnabled:",
    proxyEnabled,
    "lastProxyPort:",
    lastProxyPort
  );
}

// isStopped reports whether the backend says this profile is switched off, as
// against still on its way up. The backend reports the state in an error
// string; popup.js reads the same shape to decide what to print.
function isStopped(status) {
  return !!status && status.error === "State: Stopped";
}

// syncProxyToBackend keeps the browser's proxy in step with the backend.
//
// The backend is the side that remembers: it keeps the switch beside its
// state and comes back from a restart connected or off, whichever the user
// left it. Everything this script knows lives in a worker the browser throws
// away. So after a restart the browser's proxy follows the backend rather than
// the other way round — unless the user has just asked for a state the backend
// has not reached yet, where the request is the newer fact.
//
// Stopped is the only state that means direct browsing. Every other state
// short of running is a connection coming up, and the browser is pointed at
// the backend through those: it refuses to dial until dialling is safe, which
// is the failure worth having over traffic leaving from the wrong address.
function syncProxyToBackend(status) {
  if (isStopped(status)) {
    wasProxied = false;
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
        : "Backend is coming up; routing the browser through it"
    );
    wasProxied = false;
    setProxy(nativeProxyPort);
  }
}

console.log("starting ts-browser-ext");

// Every popup that is currently open. It used to be a single port, so opening
// the panel while popup.html was also open in a tab left the tab frozen on
// whatever it had rendered first.
const popupPorts = new Set();

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
    // Someone is looking. Sitting out a backoff delay now is lost time.
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

// installGiveUpAfter is how many failed connects in a row it takes before a
// backend that has answered before is presumed gone rather than restarting.
const installGiveUpAfter = 3;

function sendPopupStatus() {
  // firefox requires that extensions settings proxies have private browsing
  // access. The promise is held: one nobody holds rejects into the
  // extension's error list when the page is being torn down around the call.
  browser.extension
    .isAllowedIncognitoAccess()
    .then((isAllowed) => {
      if (!isAllowed) {
        sendToPopup({ needsIncognitoPermission: true });
      }
    })
    .catch((error) => {
      console.error("checking private browsing access:", error && error.message);
    });

  if (deadPort) {
    setPopupIcon("need-install");
    console.log("sendPopupStatus... no nmPort");
    // A host that has answered before — in this worker's life, or in an
    // earlier one, which storage remembers — is installed, so a dead port
    // means it is being restarted, not missing. The same goes while the
    // profile has not been read yet: that read is asynchronous, and the
    // popup opening is often what started this worker. Only once reconnects
    // keep failing is it presumed gone, and the install command shown, with
    // the browser's reason next to it.
    // And while the very first attempt is still in flight — the port is
    // open and nothing has failed yet — the honest word is "connecting",
    // not "install": a host takes a moment to answer, and a popup opened
    // right after a reload used to catch that moment and print the install
    // command over a backend that was about to speak.
    const firstAttemptPending = !nmPortClosed && failedConnects === 0;
    if (
      (everConnected || hostSeen || profileReadPending || firstAttemptPending) &&
      failedConnects <= installGiveUpAfter
    ) {
      sendToPopup({ reconnecting: true, error: portError });
      return;
    }
    sendToPopup({
      installCmd:
        "go run github.com/iazat/ts-browser-ext@latest --install=" +
        browserByte() +
        browser.runtime.id,
      error: portError,
    });
    return;
  }
  setPopupIcon(!!(lastStatus && lastStatus.running));

  if (lastInitError) {
    sendToPopup({ status: { error: "Backend failed to start: " + lastInitError } });
    return;
  }
  sendToPopup({ status: lastStatus });
}

// rememberStatus keeps the last status where a popup can read it without this
// script being awake at all, so it can paint what was last true while a
// restarted backend is still starting Tailscale, instead of sitting blank.
function rememberStatus(status) {
  browser.storage.local.set({ lastStatus: status }).catch((error) => {
    // Only costs the next popup its head start.
    console.error("caching the last status:", error.message);
  });
}

function sendToPopup(v) {
  for (const port of popupPorts) {
    try {
      port.postMessage(v);
    } catch (error) {
      // A popup that closed between the check and the post.
      popupPorts.delete(port);
    }
  }
}

let nmPort = null; // even non-null if lacking permission
// deadPort means no live backend has answered on nmPort. It is only cleared
// by a message, so it stays set while a freshly spawned host is still
// starting; nmPortClosed is the narrower fact that the browser has reported
// nmPort disconnected, which is what decides whether a new one may be opened.
let deadPort = true;
let nmPortClosed = true;
let portError = null;
// everConnected records that a native host answered at least once since this
// page started; hostSeen, that one ever did in this profile, which storage
// remembers across workers. Either tells a restart apart from a missing
// install.
let everConnected = false;
let hostSeen = false;
// failedConnects counts disconnects since the last message from a host.
let failedConnects = 0;
// lastInitError is the backend's reason for failing to start tsnet, shown in
// the popup until a host starts cleanly.
let lastInitError = null;

function rememberHostSeen() {
  if (hostSeen) {
    return;
  }
  hostSeen = true;
  browser.storage.local.set({ hostSeen: true }).catch((error) => {
    console.error("remembering that the backend is installed:", error.message);
    hostSeen = false;
  });
}

// Reconnection is retried with backoff rather than at a fixed second. A host
// that is missing fails instantly and would otherwise be tried every second
// for as long as the browser runs; one that is crashing on start gets the same
// treatment. Any answer from a host resets the delay.
const reconnectDelayMin = 1000;
const reconnectDelayMax = 30000;
let reconnectDelay = reconnectDelayMin;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer !== null || !nmPortClosed) {
    return;
  }
  console.log("Reconnecting to native host in " + reconnectDelay + "ms");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToNativeHost();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, reconnectDelayMax);
}

// reconnectNow tries again straight away, dropping whatever backoff has built
// up. Its callers are the events that mean the machine is back and someone is
// about to browse; sitting out a 30 second delay then is pure lost time. It
// does nothing while a port is open, so it costs nothing when the backend is
// healthy.
function reconnectNow(why) {
  if (nmPort && !nmPortClosed) {
    return;
  }
  console.log("Reconnecting to the native host now: " + why);
  reconnectDelay = reconnectDelayMin;
  connectToNativeHost();
}

connectToNativeHost();

// Everything that means "the machine is back".
//
// The port to the native host is what keeps this event page alive: Firefox
// does not unload a background page while it has a message port open. When
// the host goes away the port closes, and unless it is reopened the page is
// unloaded once idle, taking the proxy.onRequest handler with it. A wake from
// sleep is the common way to get there: the browser suspends, the page is
// discarded, and the host, its child process, dies with it. A timer set by
// this script dies with the page too. So the retry is also held by
// the browser: an alarm, which starts the worker again to deliver it, and the
// idle state flipping back to active, which is the earliest word that someone
// is about to load a page. Each does nothing unless the port is dead.
const reconnectAlarmName = "reconnect-native-host";

// The answer is a promise on Chrome and nothing on Firefox, and a promise
// nobody holds rejects into the extension's error list when the browser is
// discarding this worker around the call. Resolve first, so either shape
// ends in the same handler.
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
  if (state === "active") {
    reconnectNow("idle state " + state);
  }
});

browser.runtime.onStartup.addListener(() => {
  reconnectNow("browser startup");
});
browser.runtime.onInstalled.addListener(() => {
  reconnectNow("extension installed or updated");
});

function connectToNativeHost() {
  // One host at a time. The old test here was "has a host answered", which
  // is false for the first moments after connectNative while the new
  // process is still starting — so a reconnect timer firing in that window
  // opened a second host, and the first, never disconnected, ran on as an
  // orphan with the browser pointed at whichever answered last.
  if (nmPort && !nmPortClosed) {
    return;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  console.log("Connecting to native messaging host...");
  const port = browser.runtime.connectNative("io.github.iazat.tailext.firefox");
  nmPort = port;
  nmPortClosed = false;

  port.onDisconnect.addListener(() => {
    if (port !== nmPort) {
      // A port we already replaced; its news is stale.
      return;
    }
    nmPortClosed = true;
    // Firefox reports why on the port itself. runtime.lastError is Chrome's
    // channel, and reading it here found nothing, so a host that died was
    // logged as a clean disconnect — and, under the old rule of only retrying
    // on an error, never reconnected.
    const error = port.error || browser.runtime.lastError;
    deadPort = true;
    failedConnects++;
    nativeProxyPort = 0; // the host is gone, and so is the port it was listening on
    // Whatever replaces it is a fresh process that knows nothing: it has to
    // be sent init again, and the status we were holding is that of a host
    // that no longer exists. Leaving didInit set here is how a restarted
    // backend used to sit forever without tsnet, the popup reading
    // "Connecting…" and every page failing, until the extension was reloaded.
    didInit = false;
    lastStatus = {};
    setPopupIcon("need-install");
    // Whether the browser was going through the host that just died, so its
    // replacement can take the browser back as soon as it has a port. And
    // not disableProxy(): that is the user's "off", and it is remembered.
    wasProxied = proxyEnabled;
    stopBrowserProxy();
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
    if (port !== nmPort) {
      console.log("ignoring a message from a port we replaced");
      return;
    }
    console.log("got message: " + JSON.stringify(message));
    if (deadPort) {
      console.log("connected to native backend");
      deadPort = false;
    }
    everConnected = true;
    failedConnects = 0;
    portError = null;
    reconnectDelay = reconnectDelayMin;
    rememberHostSeen();
    if (message.procRunning) {
      if (message.procRunning.port) {
        nativeProxyPort = message.procRunning.port;
        // Whether to route the browser through it is normally the next
        // status message's call, not this one's: the backend remembers
        // whether this profile was left connected, and a worker that has
        // just started remembers nothing. Routing on sight is what switched
        // the tailnet back on for people who had switched it off. The
        // exceptions are a user who has asked for it, and a browser that
        // was going through the host that just died: that one is on a
        // direct connection until something re-points it.
        if (proxyWanted === true || wasProxied) {
          wasProxied = false;
          setProxy(message.procRunning.port);
        }
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
      rememberStatus(message.status);
      syncProxyToBackend(message.status);
    }
    maybeSendInit();
    deliverPendingWant();
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

var profileID = "";
var didInit = false;
let profileReadPending = false;
const profileRetryMs = 1000;

// deliverPendingWant hands the backend the switch the user flipped while there
// was nothing to hand it to. It goes after the init, which the same handler
// sends first, so the host has a tailnet to apply it to.
function deliverPendingWant() {
  if (pendingWant === null || deadPort || !didInit) {
    return;
  }
  const want = pendingWant;
  pendingWant = null;
  console.log("Delivering the switch the user flipped while we were down: " + want);
  nmPort.postMessage({ cmd: want ? "up" : "down" });
  if (want && nativeProxyPort) {
    setProxy(nativeProxyPort);
  }
}

function maybeSendInit() {
  if (!profileID) {
    // Nothing to init with yet. Every message from a backend is another
    // chance at a read that storage refused earlier.
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
// and storage does refuse to answer sometimes — when the browser is tearing
// this worker down around the call — handing back nothing at all. Reading a
// field off that nothing threw, and the init the backend needs went with it.
// So a refusal is something to ask again about, never something to invent an
// id over.
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
        throw new Error("storage answered nothing");
      }
      hostSeen = hostSeen || !!result.hostSeen;
      if (result.profileId) {
        console.log("Profile ID already exists:", result.profileId);
        profileID = result.profileId;
        maybeSendInit();
        sendPopupStatus(); // correct whatever the popup was told before this
        return;
      }
      const profileId = crypto.randomUUID();
      return browser.storage.local.set({ profileId }).then(() => {
        console.log("Generated profile ID:", profileId);
        profileID = profileId;
        maybeSendInit();
        sendPopupStatus();
      });
    })
    .catch((error) => {
      // A read that refused, or an id that did not stick — the latter is
      // worse than none: the next start would make another one, and the
      // tailnet would see a new machine. Ask again either way.
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
    // What the popup asked for, rather than the inverse of a variable this
    // worker may have just lost: a fresh worker starts with proxyEnabled
    // false, so a blind flip turned a click meaning "off" into "on". The
    // popup sends the state of the switch the user just operated.
    const want =
      typeof message.enable === "boolean" ? message.enable : !proxyEnabled;
    console.log("bg: toggleProxy received, asked for " + want);
    proxyWanted = want;
    let response;
    if (want) {
      console.log("bg: Enabling proxy");
      enableProxy();
      response = { status: lastStatus };
    } else {
      console.log("bg: Disabling proxy");
      disableProxy();
      response = { status: "Disconnected" };
      // Switching off is immediate. Switching on is not: the icon waits for
      // the backend to say it is up.
      setPopupIcon(false);
    }
    return Promise.resolve(response);
  }
});
