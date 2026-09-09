// Exercises both copies of background.js against a mocked WebExtension API.
//
// The two extensions are maintained as separate files, so anything that only
// gets fixed in one of them is a bug waiting to happen. Every behaviour that
// is supposed to be shared is asserted for both.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackground, connectPopup, sendCommand, plain, fireTimers } from "./webext-mock.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// isProxied answers "is the browser currently routed through the native host?"
// The two engines do it differently: Chrome sets a proxy setting, Firefox
// registers a proxy.onRequest handler.
const TARGETS = [
  {
    name: "chrome",
    file: path.join(ROOT, "background.js"),
    flavor: "chrome",
    isProxied: (calls) => calls.proxyModes.at(-1) === "fixed_servers",
  },
  {
    name: "firefox",
    file: path.join(ROOT, "firefox", "background.js"),
    flavor: "browser",
    isProxied: (calls) => calls.proxyListeners.length === 1,
  },
];

// bringUp puts the extension in the state it reaches once the native host has
// started tsnet and reported the port its proxy listens on.
function bringUp(calls, port = 41234) {
  calls.onNativeMessage({ procRunning: { port }, status: { running: true, tailnet: "test@example.com" } });
}

for (const target of TARGETS) {
  describe(`${target.name}: background.js`, () => {
    test("connects to its own native messaging host", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      assert.equal(calls.nativeHostName, `io.github.iazat.tailext.${target.name}`);
    });

    test("resets the browser proxy to direct when disabled", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.proxyModes.length = 0;

      sandbox.disableProxy();

      assert.ok(
        calls.proxyModes.includes("direct"),
        "disabling must hand the browser back to a direct connection, or every " +
          "page load fails against a proxy port that is no longer listening"
      );
    });

    test("resets the browser proxy when the native host goes away", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.proxyModes.length = 0;

      calls.onNativeDisconnect();

      assert.ok(calls.proxyModes.includes("direct"));
    });

    test("tells the native host to stop when disabled", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.toNativeHost.length = 0;

      sandbox.disableProxy();

      assert.ok(calls.toNativeHost.some((m) => m.cmd === "down"));
    });

    test("pulls a fresh status when the popup connects", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.toNativeHost.length = 0;

      connectPopup(calls);

      assert.ok(
        calls.toNativeHost.some((m) => m.cmd === "get-status"),
        "without this the popup shows stale state after a login that finished while it was closed"
      );
    });

    test("forwards the chosen exit node to the native host", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.toNativeHost.length = 0;

      await sendCommand(calls, { command: "setExitNode", exitNode: "nyc.tail1234.ts.net" });

      const sent = calls.toNativeHost.find((m) => m.cmd === "set-exit-node");
      assert.ok(sent, "no set-exit-node reached the native host");
      assert.equal(sent.exitNode, "nyc.tail1234.ts.net");
    });

    test("clearing the exit node forwards an empty selection", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.toNativeHost.length = 0;

      await sendCommand(calls, { command: "setExitNode", exitNode: "" });

      const sent = calls.toNativeHost.find((m) => m.cmd === "set-exit-node");
      assert.ok(sent);
      assert.equal(sent.exitNode, "");
    });

    test("toggling off answers the popup and resets the proxy", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls); // proxy is on, so the next toggle turns it off
      calls.proxyModes.length = 0;

      const reply = await sendCommand(calls, { command: "toggleProxy" });

      assert.deepEqual(plain(reply), { status: "Disconnected" });
      assert.ok(calls.proxyModes.includes("direct"));
    });

    // The native host reports its proxy port once, in procRunning at startup,
    // and its listener stays up across a down/up cycle — "up" comes back as a
    // status message, not another procRunning. So re-enabling has to point the
    // browser back at the remembered port itself, or the toggle is one-way:
    // it turns off and never comes back on without reloading the extension.
    test("re-enabling routes the browser through the proxy again", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      assert.ok(target.isProxied(calls), "expected to be proxied after connecting");

      sandbox.disableProxy();
      assert.ok(!target.isProxied(calls), "expected direct browsing after disabling");

      sandbox.enableProxy();

      assert.ok(
        target.isProxied(calls),
        "the browser was left on a direct connection after re-enabling — the toggle only works once"
      );
    });

    test("re-enabling also tells the native host to come back up", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      sandbox.disableProxy();
      calls.toNativeHost.length = 0;

      sandbox.enableProxy();

      assert.ok(calls.toNativeHost.some((m) => m.cmd === "up"));
    });

    test("does not resurrect a proxy after the native host dies", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect(); // host gone; its listener went with it

      sandbox.enableProxy();

      assert.ok(
        !target.isProxied(calls),
        "pointed the browser at a port whose listener no longer exists"
      );
    });

    // setIcon reports a missing file through runtime.lastError, which the
    // extension only logs — so renaming artwork breaks the toolbar icon with
    // nothing visible but a console line. Check the files are really there.
    test("every icon it asks the browser for exists on disk", async () => {
      const fs = await import("node:fs");
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      const dir = path.dirname(target.file);

      for (const state of ["online", "offline", "need-install"]) {
        sandbox.setPopupIcon(state);
      }
      const referenced = new Set(
        calls.icons.flatMap((p) => (typeof p === "string" ? [p] : Object.values(p)))
      );
      assert.ok(referenced.size > 0, "no icon was ever requested");

      for (const rel of referenced) {
        assert.ok(
          fs.existsSync(path.join(dir, rel)),
          `${target.name} asks for ${rel}, which is not in ${dir}`
        );
      }
    });

    test("the icons the manifest declares exist on disk", async () => {
      const fs = await import("node:fs");
      const dir = path.dirname(target.file);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

      const declared = [
        ...Object.values(manifest.icons ?? {}),
        ...Object.values(manifest.action?.default_icon ?? {}),
      ];
      assert.ok(declared.length > 0, "the manifest declares no icons at all");

      for (const rel of declared) {
        assert.ok(fs.existsSync(path.join(dir, rel)), `manifest names ${rel}, which is missing`);
      }
    });

    test("shows the install prompt with its own browser byte", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      // No native host has answered yet, so the port is still considered dead.
      // Until the profile read settles that reads as a reconnect, not an
      // install; let it settle.
      await new Promise((r) => setImmediate(r));
      connectPopup(calls);

      const prompt = calls.toPopup.find((m) => m.installCmd);
      assert.ok(prompt, "popup was never told how to install the native host");
      const expected = target.name === "chrome" ? "--install=C" : "--install=F";
      assert.ok(
        prompt.installCmd.includes(expected),
        `expected ${expected} in ${JSON.stringify(prompt.installCmd)}`
      );
    });

    // The byte is a property of the file, not of the machine it runs on. Both
    // copies used to work it out at runtime, and both signals have since gone
    // soft: Chrome defines `browser` too, and a user agent is whatever the
    // browser, an extension or the user says it is. Getting it wrong prints a
    // command that registers the native host under the other browser's name,
    // after which the popup still asks to install it.
    test("names its own browser whatever the environment claims", async () => {
      const otherGlobal = target.name === "chrome" ? "browser" : "chrome";
      const otherAgent =
        target.name === "chrome"
          ? "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

      const { calls } = loadBackground(target.file, target.flavor, {
        globals: { [otherGlobal]: {}, navigator: { userAgent: otherAgent } },
      });
      await new Promise((r) => setImmediate(r));
      connectPopup(calls);

      const { installCmd } = calls.toPopup.find((m) => m.installCmd);
      const expected = target.name === "chrome" ? "--install=C" : "--install=F";
      const wrong = target.name === "chrome" ? "--install=F" : "--install=C";
      assert.ok(
        installCmd.includes(expected),
        `expected ${expected} in ${JSON.stringify(installCmd)}`
      );
      assert.ok(
        !installCmd.includes(wrong),
        `the ${target.name} copy read its browser off the environment: ${JSON.stringify(installCmd)}`
      );
    });

    // Every native host is a fresh process that knows nothing until it is sent
    // init. The flag that stops init being sent twice used to survive the
    // host dying, so its replacement was never told to start tsnet: it sat
    // reporting NoState, the popup read "Connecting…" for good, and every
    // page failed with "no tsnet.Server" until the extension was reloaded.
    test("sends init again to the host that replaces a dead one", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      // Firefox's storage API answers through a promise, so the profile id
      // is only known after a turn of the microtask queue.
      await new Promise((r) => setImmediate(r));
      bringUp(calls);
      assert.equal(
        calls.toNativeHost.filter((m) => m.cmd === "init").length,
        1,
        "expected exactly one init for the first host"
      );

      calls.onNativeDisconnect();
      fireTimers(calls); // the reconnect
      calls.toNativeHost.length = 0;
      bringUp(calls, 41235);

      const inits = calls.toNativeHost.filter((m) => m.cmd === "init");
      assert.equal(inits.length, 1, "the replacement host was never sent init");
      assert.equal(inits[0].initID, "test-profile-id");
    });

    test("does not offer a dead host's status as the new one's", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect();
      calls.toPopup.length = 0;

      connectPopup(calls);

      const stale = calls.toPopup.find((m) => m.status && m.status.running);
      assert.equal(stale, undefined, "the popup was shown the status of a host that no longer exists");
    });

    // Chrome's own guidance: the native port is what keeps the worker alive,
    // so reconnect from onDisconnect. That used to happen only when the
    // browser attached an error to the disconnect. A host that exited on its
    // own — its stdin closed, its init failed — reported no error on some
    // paths, and the extension stayed without a backend until reloaded.
    test("reconnects after a disconnect that carries no error", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      const before = calls.connects;

      calls.onNativeDisconnect(); // lastError is null, port.error is null
      assert.ok(calls.timers.length > 0, "no reconnect was scheduled");
      fireTimers(calls);

      assert.equal(calls.connects, before + 1, "connectNative was not called again");
    });

    // connectNative spawns the host, and its first message — the one that
    // marks the port live — arrives some hundreds of milliseconds later. A
    // reconnect timer firing in that window used to open a second host and
    // abandon the first, still running, with the browser pointed at whichever
    // reported its port last.
    test("does not open a second host while the first is still starting", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      calls.onNativeDisconnect(); // the first attempt found no host
      fireTimers(calls); // the reconnect spawns one
      const after = calls.connects;

      sandbox.connectToNativeHost(); // e.g. runtime.onStartup, or another timer
      assert.equal(calls.connects, after, "a second host was spawned while the first was starting");

      calls.onNativeMessage({ procRunning: { port: 41234 } });
      sandbox.connectToNativeHost();
      assert.equal(calls.connects, after, "a second host was spawned next to a live one");
    });

    test("connecting explicitly cancels a pending reconnect timer", () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      calls.onNativeDisconnect();
      assert.equal(calls.timers.length, 1);
      sandbox.connectToNativeHost();
      assert.equal(calls.timers.length, 0, "the timer would have spawned a second host");
    });

    test("backs off between failed reconnects and resets once a host answers", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      const delays = [];
      for (let i = 0; i < 6; i++) {
        calls.onNativeDisconnect();
        assert.equal(calls.timers.length, 1, `attempt ${i}: expected one pending reconnect`);
        delays.push(calls.timers[0].ms);
        fireTimers(calls);
      }
      for (let i = 1; i < delays.length; i++) {
        assert.ok(delays[i] >= delays[i - 1], `delays should not shrink: ${delays}`);
      }
      assert.ok(delays.at(-1) > delays[0], `delays never grew: ${delays}`);
      assert.ok(delays.at(-1) <= 30000, `delay grew past the cap: ${delays}`);

      bringUp(calls);
      calls.onNativeDisconnect();
      assert.equal(calls.timers[0].ms, delays[0], "a host answering should reset the backoff");
    });

    test("wakes up and reconnects at browser start", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      assert.equal(typeof calls.onStartup, "function", "no runtime.onStartup listener: the worker will not run at browser start, and the proxy setting it left behind points at nothing");
      assert.equal(typeof calls.onInstalled, "function", "no runtime.onInstalled listener");
      calls.onNativeDisconnect();
      const before = calls.connects;
      calls.onStartup();
      assert.equal(calls.connects, before + 1);
    });

    // A host that answered and then went away is being replaced, not
    // installed. Telling the user to run the install command there sends
    // them to redo something that is already done.
    test("tells the popup it is reconnecting rather than asking for an install", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect();
      calls.toPopup.length = 0;

      connectPopup(calls);

      assert.ok(calls.toPopup.some((m) => m.reconnecting), "popup was not told about the reconnect");
      assert.ok(!calls.toPopup.some((m) => m.installCmd), "popup was asked to install a host that was working a moment ago");
    });

    test("puts the browser's reason next to the install prompt", async () => {
      const { sandbox, calls } = loadBackground(target.file, target.flavor);
      await new Promise((r) => setImmediate(r));
      const message = "Native host has exited.";
      // Chrome reports through runtime.lastError, Firefox on the port.
      if (target.flavor === "chrome") sandbox.chrome.runtime.lastError = { message };
      else calls.nativePort.error = { message };
      calls.onNativeDisconnect();
      if (target.flavor === "chrome") sandbox.chrome.runtime.lastError = null;

      connectPopup(calls);

      const prompt = calls.toPopup.find((m) => m.installCmd);
      assert.ok(prompt, "no install prompt was sent");
      assert.equal(prompt.error, message);
    });

    test("surfaces a failed backend start in the popup", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      calls.onNativeMessage({ procRunning: { port: 41234 } });
      calls.onNativeMessage({ init: { error: "starting tsnet.Server: state dir is read-only" } });
      calls.toPopup.length = 0;

      connectPopup(calls);

      const shown = calls.toPopup.find((m) => m.status && m.status.error);
      assert.ok(shown, "the popup was not told the backend failed to start");
      assert.ok(shown.status.error.includes("read-only"), shown.status.error);
    });

    // ---- Coming back after the machine sleeps ----
    //
    // Sleep takes the whole chain down: the browser suspends, the worker is
    // discarded, and the host, its child process, dies with it. A timer set
    // by this script dies with the worker too, so the retry has to be held by
    // the browser — an alarm, or the idle state flipping back to active.

    test("asks the browser for a periodic alarm and listens for it", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      assert.equal(calls.alarmsCreated.length, 1, "no alarm was registered");
      assert.ok(calls.alarmsCreated[0].periodInMinutes >= 1);
      assert.equal(typeof calls.onAlarm, "function", "no alarms.onAlarm listener");
      assert.equal(typeof calls.onIdle, "function", "no idle.onStateChanged listener");
    });

    test("an alarm reconnects a dead port and leaves a live one alone", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      const live = calls.connects;
      calls.onAlarm({ name: calls.alarmsCreated[0].name });
      assert.equal(calls.connects, live, "a healthy connection was replaced on an alarm");

      calls.onNativeDisconnect();
      calls.onAlarm({ name: calls.alarmsCreated[0].name });
      assert.equal(calls.connects, live + 1, "the alarm did not reconnect a dead port");
    });

    test("the machine becoming active reconnects a dead port at once", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect();
      const before = calls.connects;
      calls.onIdle("active");
      assert.equal(calls.connects, before + 1);
      assert.equal(calls.timers.filter((t) => t.ms >= 1000).length, 0, "the backoff timer was left armed beside the immediate reconnect");
    });

    test("opening the popup while the port is dead reconnects at once", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect();
      const before = calls.connects;
      connectPopup(calls);
      assert.equal(calls.connects, before + 1, "someone is looking; the backoff should not be sat out");
    });

    // ---- The backend gets the last word on whether to route ----
    //
    // The backend remembers its switch on disk; a fresh worker remembers
    // nothing. Routing on procRunning switched the tailnet back on for people
    // who had switched it off.

    test("procRunning alone does not route; the first status decides", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      calls.onNativeMessage({ procRunning: { port: 41234 } });
      assert.ok(!target.isProxied(calls), "routed on sight, before the backend said whether it is on");

      calls.onNativeMessage({ status: { running: true, tailnet: "t" } });
      assert.ok(target.isProxied(calls), "a running backend should be routed through");
    });

    test("a backend that comes back switched off leaves the browser direct", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      calls.onNativeMessage({ procRunning: { port: 41234 } });
      calls.onNativeMessage({ status: { running: false, error: "State: Stopped" } });
      assert.ok(!target.isProxied(calls), "routed into a backend that reports Stopped");
    });

    test("a backend still coming up is routed, so nothing leaves direct", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      calls.onNativeMessage({ procRunning: { port: 41234 } });
      calls.onNativeMessage({ status: { running: false, error: "State: Starting" } });
      assert.ok(target.isProxied(calls), "left on a direct connection while the backend starts; with an exit node that is a leak");
    });

    test("a replacement host takes the browser back the moment it has a port", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls, 41234);
      calls.onNativeDisconnect();
      fireTimers(calls);
      calls.onNativeMessage({ procRunning: { port: 41235 } }); // no status yet
      assert.ok(target.isProxied(calls), "the browser that was going through the dead host was left direct until the new one finished starting");
    });

    test("off stays off across a restart, whatever the backend reports", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      await sendCommand(calls, { command: "toggleProxy", enable: false });
      assert.ok(!target.isProxied(calls));

      calls.onNativeDisconnect();
      fireTimers(calls);
      bringUp(calls, 41235); // reports running
      assert.ok(!target.isProxied(calls), "the user's off was overruled by the backend");
    });

    test("a switch flipped while the backend is away is delivered to the next one", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.onNativeDisconnect();
      await sendCommand(calls, { command: "toggleProxy", enable: true });
      fireTimers(calls);
      calls.toNativeHost.length = 0;
      await new Promise((r) => setImmediate(r));
      calls.onNativeMessage({ procRunning: { port: 41235 } });

      const cmds = calls.toNativeHost.map((m) => m.cmd);
      assert.ok(cmds.indexOf("init") !== -1, "no init for the replacement");
      assert.ok(cmds.indexOf("up") > cmds.indexOf("init"), `up must follow init, got ${cmds}`);
      assert.ok(target.isProxied(calls));
    });

    test("the toggle honours the state the popup sends", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      calls.toNativeHost.length = 0;
      await sendCommand(calls, { command: "toggleProxy", enable: true }); // already on
      assert.ok(calls.toNativeHost.some((m) => m.cmd === "up"), "asked for on, sent nothing");
      assert.ok(!calls.toNativeHost.some((m) => m.cmd === "down"), "asked for on, sent down");
    });

    // ---- Storage that answers nothing ----

    test("survives storage refusing to answer, and inits once it does", async () => {
      // Two refusals: the read at start, and the one a backend's first
      // message provokes. Neither may throw, invent an id, or send init.
      const { calls } = loadBackground(target.file, target.flavor, { storageFailures: 2 });
      await new Promise((r) => setImmediate(r));
      calls.onNativeMessage({ procRunning: { port: 41234 } });
      await new Promise((r) => setImmediate(r));
      assert.ok(!calls.toNativeHost.some((m) => m.cmd === "init"), "sent init with no profile id");
      assert.ok(calls.timers.length > 0, "no retry of the refused read");

      fireTimers(calls); // the read that works
      await new Promise((r) => setImmediate(r));
      const init = calls.toNativeHost.find((m) => m.cmd === "init");
      assert.ok(init, "never sent init after storage answered");
      assert.equal(init.initID, "test-profile-id");
    });

    test("never invents a profile id over a refused read", async () => {
      const { calls } = loadBackground(target.file, target.flavor, { storageFailures: 1 });
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.storage.profileId, "test-profile-id", "the stored id was replaced");
    });

    // ---- What the popup is told on a fresh worker ----

    test("a fresh worker in a profile that has seen a backend says reconnecting", async () => {
      const { calls } = loadBackground(target.file, target.flavor, {
        storage: { profileId: "test-profile-id", hostSeen: true },
      });
      await new Promise((r) => setImmediate(r));
      calls.onNativeDisconnect(); // the first connect failed
      connectPopup(calls);
      assert.ok(calls.toPopup.some((m) => m.reconnecting), "told to install a backend it has used before");
      assert.ok(!calls.toPopup.some((m) => m.installCmd));
    });

    test("gives up on the reconnect story once connects keep failing", async () => {
      const { calls } = loadBackground(target.file, target.flavor, {
        storage: { profileId: "test-profile-id", hostSeen: true },
      });
      await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 5; i++) {
        calls.onNativeDisconnect();
        fireTimers(calls);
      }
      connectPopup(calls);
      assert.ok(calls.toPopup.some((m) => m.installCmd), "kept promising a reconnect for a backend that is gone");
    });

    test("remembers that a backend answered, for the next worker", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.storage.hostSeen, true);
    });

    test("caches the last status for the popup to paint early", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.storage.lastStatus && calls.storage.lastStatus.tailnet, "test@example.com");
    });

    test("does not redraw the icon for a status that changes nothing", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      const drawn = calls.icons.length;
      bringUp(calls);
      bringUp(calls);
      assert.equal(calls.icons.length, drawn, "the toolbar was redrawn for identical statuses");
    });

    // This fork's native host understands set-exit-node and reports exitNodes;
    // upstream's does not. Pointing people at the wrong module hands them a
    // host that half-works, with no hint as to why, so pin it to this repo.
    test("the install prompt installs this fork, not upstream", async () => {
      const { calls } = loadBackground(target.file, target.flavor);
      await new Promise((r) => setImmediate(r));
      connectPopup(calls);

      const { installCmd } = calls.toPopup.find((m) => m.installCmd);
      assert.ok(
        installCmd.includes("github.com/iazat/ts-browser-ext"),
        `install prompt points somewhere else: ${JSON.stringify(installCmd)}`
      );
      assert.ok(
        !installCmd.includes("tailscale/ts-browser-ext"),
        "install prompt still points at upstream, whose host has no exit node support"
      );
    });
  });
}

describe("firefox: native port lifecycle", () => {
  const { file, flavor } = TARGETS.find((t) => t.name === "firefox");

  // Firefox reports a disconnect's cause on the port, not in runtime.lastError,
  // which is Chrome's channel and is undefined in a promise-based API. Reading
  // only lastError meant a crashed host looked like a clean disconnect.
  test("reads the disconnect reason from port.error", () => {
    const { calls } = loadBackground(file, flavor);
    bringUp(calls);
    calls.nativePort.error = { message: "No such native application io.github.iazat.tailext.firefox" };
    calls.onNativeDisconnect();

    connectPopup(calls);
    const told = calls.toPopup.find((m) => m.reconnecting);
    assert.ok(told, "popup was not told about the disconnect");
    assert.match(told.error, /No such native application/);
  });
});

describe("firefox: proxy.onRequest handler lifecycle", () => {
  const { file, flavor } = TARGETS.find((t) => t.name === "firefox");

  // Firefox routes through a proxy.onRequest handler rather than a proxy
  // setting. proxyHandler() builds a fresh closure each call, so the handler
  // has to be held onto — passing a newly built one to removeListener silently
  // matches nothing and leaves the old handler routing to a dead port.
  test("disabling removes the handler it actually registered", () => {
    const { sandbox, calls } = loadBackground(file, flavor);
    bringUp(calls);
    assert.equal(calls.proxyListeners.length, 1, "expected one handler after connecting");

    sandbox.disableProxy();

    assert.equal(calls.removeMisses, 0, "removeListener was called with a handler that was never registered");
    assert.equal(calls.proxyListeners.length, 0, "a dead proxy handler is still installed");
  });

  test("a port of zero from the native host removes the handler too", () => {
    const { sandbox, calls } = loadBackground(file, flavor);
    bringUp(calls);

    sandbox.setProxy(0);

    assert.equal(calls.removeMisses, 0);
    assert.equal(calls.proxyListeners.length, 0);
  });

  test("reconnecting does not stack up handlers", () => {
    const { calls } = loadBackground(file, flavor);
    bringUp(calls, 41234);
    bringUp(calls, 41235);
    bringUp(calls, 41236);

    assert.equal(calls.proxyListeners.length, 1, "each reconnect left another handler behind");
  });

  test("routes 100.100.100.100 over http and everything else over socks", () => {
    const { calls } = loadBackground(file, flavor);
    bringUp(calls, 41234);
    const handler = calls.proxyListeners[0];

    // Only socks can resolve names on Firefox, but the management page is
    // served by the native host itself and has to go over http.
    assert.deepEqual(plain(handler({ url: "http://100.100.100.100/" })), {
      type: "http",
      host: "127.0.0.1",
      port: 41234,
    });

    const other = handler({ url: "https://example.com/path" });
    assert.equal(other.type, "socks");
    assert.equal(other.port, 41234);
    assert.equal(other.proxyDNS, true);
  });
});
