// Exercises both copies of background.js against a mocked WebExtension API.
//
// The two extensions are maintained as separate files, so anything that only
// gets fixed in one of them is a bug waiting to happen. Every behaviour that
// is supposed to be shared is asserted for both.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBackground,
  connectPopup,
  sendCommand,
  plain,
  runTimers,
  fireAlarm,
  goIdle,
} from "./webext-mock.mjs";

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

// flush lets the promise-flavoured mocks settle. Firefox's storage answers with
// a promise, so what the script reads out of storage is only in place a
// microtask after it starts.
const flush = () => new Promise((r) => setTimeout(r, 0));

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

    // The backend sends a status per notification and a live tailnet is never
    // quiet. Each one had the browser fetch and decode four PNGs for a toolbar
    // icon that already looked exactly like that — work landing on the button
    // the user is reaching for.
    test("does not redraw an icon the toolbar is already showing", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      const before = calls.icons.length;

      for (let i = 0; i < 5; i++) {
        calls.onNativeMessage({ status: { running: true, tailnet: "test@example.com" } });
      }

      assert.equal(calls.icons.length, before, "redrew an unchanged icon on every status");
    });

    test("still redraws when the icon actually changes", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      const before = calls.icons.length;

      calls.onNativeMessage({ status: { running: false, error: "State: Stopped" } });

      assert.ok(
        calls.icons.length > before,
        "the toolbar was left showing online for a tailnet that is switched off"
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

    test("shows the install prompt with its own browser byte", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      // No native host has answered yet, so the port is still considered dead.
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
    test("names its own browser whatever the environment claims", () => {
      const otherGlobal = target.name === "chrome" ? "browser" : "chrome";
      const otherAgent =
        target.name === "chrome"
          ? "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

      const { calls } = loadBackground(target.file, target.flavor, {
        [otherGlobal]: {},
        navigator: { userAgent: otherAgent },
      });
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


    // Everything below is about the machine going away and coming back, which
    // on a Mac is an everyday event: the lid closes, the browser suspends, the
    // worker running background.js is discarded, and the native host — a child
    // process of the browser — dies with the port that carried it. What the
    // user sees on waking is a reset extension, and how long it stays reset is
    // entirely up to this file.
    describe("waking up", () => {
      test("reconnects after the native host goes away", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        const before = calls.nativeConnects;

        calls.onNativeDisconnect();
        runTimers(calls);

        assert.ok(
          calls.nativeConnects > before,
          "nothing tried to start a new native host, so the extension stays dead until something else restarts this script"
        );
      });

      // A host that exits by itself reports no lastError, and that is the
      // disconnect a sleeping machine produces. The old code retried only the
      // other kind, so waking up was the case it did not cover.
      test("reconnects when the disconnect reports no error at all", () => {
        const { calls, sandbox } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        const before = calls.nativeConnects;
        sandbox[target.flavor].runtime.lastError = null;

        calls.onNativeDisconnect();
        runTimers(calls);

        assert.ok(calls.nativeConnects > before, "a clean disconnect was never retried");
      });

      test("backs off rather than restarting the host on a loop", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);

        const delays = [];
        for (let i = 0; i < 4; i++) {
          calls.onNativeDisconnect();
          delays.push(calls.timers.filter(Boolean)[0].ms);
          runTimers(calls);
        }

        assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
      });

      // The host that answers a reconnect is a new process with no tsnet in
      // it. Without another init it sits there with a proxy listener and no
      // tailnet behind it, and the extension used to point the browser at it
      // anyway: every page load then failed, and no status ever arrived, so
      // the popup kept showing whatever it had said before the machine slept.
      test("initialises the backend it reconnects to", async () => {
        const { calls } = loadBackground(target.file, target.flavor);
        await flush(); // the profile id it inits with comes out of storage
        bringUp(calls);
        calls.onNativeDisconnect();
        runTimers(calls);
        calls.toNativeHost.length = 0;

        calls.onNativeMessage({ procRunning: { port: 41235 } }); // the new host says hello

        assert.ok(
          calls.toNativeHost.some((m) => m.cmd === "init"),
          "the replacement host was never told to start tsnet, so it proxies nothing"
        );
      });

      // Every connectNative starts a process, and several things can call for
      // a reconnect at the same moment.
      test("does not start a second backend on top of one that is starting", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        const before = calls.nativeConnects; // the load has asked for one already

        goIdle(calls, "active");
        fireAlarm(calls, "reconnect-native-host");
        connectPopup(calls);

        assert.equal(calls.nativeConnects, before, "started more than one native host at once");
      });

      test("retries at once when the machine goes active again", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.onNativeDisconnect();
        const before = calls.nativeConnects;

        goIdle(calls, "active");

        assert.equal(calls.nativeConnects, before + 1, "a wake did not shorten the wait");
      });

      test("leaves the backend alone while it is healthy", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        const before = calls.nativeConnects;

        goIdle(calls, "active");
        fireAlarm(calls, "reconnect-native-host");

        assert.equal(calls.nativeConnects, before, "started a second host on top of a working one");
      });

      // The worker is not alive to run a timer for long: the browser discards
      // it when it goes idle and suspends everything when the lid closes. An
      // alarm is held by the browser, which starts the worker again to deliver
      // it, so it is what actually gets the extension back after a sleep.
      test("keeps an alarm so the browser can restart it", () => {
        const { calls } = loadBackground(target.file, target.flavor);

        const alarm = calls.alarmsCreated.find((a) => a.name === "reconnect-native-host");
        assert.ok(alarm, "no alarm was registered, so a discarded worker stays discarded");
        assert.ok(alarm.periodInMinutes > 0, "the alarm fires once and never again");
      });

      test("the alarm reconnects a dead host", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.onNativeDisconnect();
        const before = calls.nativeConnects;

        fireAlarm(calls, "reconnect-native-host");

        assert.equal(calls.nativeConnects, before + 1);
      });

      test("opening the popup retries immediately", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.onNativeDisconnect();
        const before = calls.nativeConnects;

        connectPopup(calls);

        assert.equal(
          calls.nativeConnects,
          before + 1,
          "someone is looking at the popup, which is the worst moment to be sitting out a backoff"
        );
      });

      test("tells the popup it is reconnecting rather than to install it again", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls); // a backend has answered, so it is plainly installed
        calls.onNativeDisconnect();
        calls.toPopup.length = 0;

        connectPopup(calls);

        assert.ok(
          calls.toPopup.some((m) => m.reconnecting),
          "the popup was told nothing about the reconnect in progress"
        );
        assert.ok(
          !calls.toPopup.some((m) => m.installCmd),
          "printed an install command at someone whose backend is installed and merely restarting"
        );
      });

      test("still offers the install command when the reconnects keep failing", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        for (let i = 0; i < 4; i++) {
          calls.onNativeDisconnect();
          runTimers(calls);
        }
        calls.toPopup.length = 0;

        connectPopup(calls);

        assert.ok(
          calls.toPopup.some((m) => m.installCmd),
          "a backend that never comes back may really be gone, and the popup has to say how to get it back"
        );
      });

      test("remembers across restarts that a backend was ever installed", async () => {
        const first = loadBackground(target.file, target.flavor);
        bringUp(first.calls);
        assert.equal(first.calls.storage.hostSeen, true, "nothing was written to survive the worker");

        // A second worker, as the browser starts after a wake: same profile,
        // same storage, no memory of anything else.
        const { calls } = loadBackground(target.file, target.flavor, {}, { storage: first.calls.storage });
        await flush();
        calls.onNativeDisconnect();
        calls.toPopup.length = 0;

        connectPopup(calls);

        assert.ok(
          calls.toPopup.some((m) => m.reconnecting),
          "a fresh worker forgot the backend was installed and asked for it to be installed again"
        );
      });

      // The browser discards an idle worker in about thirty seconds and the
      // native host, its child, dies with it — so the next click pays for a
      // process starting Tailscale from cold. Messages reset that timer.
      test("keeps its worker alive while a backend is connected", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.toNativeHost.length = 0;

        runTimers(calls); // the keepalive comes due

        assert.ok(
          calls.toNativeHost.some((m) => m.cmd === "get-status"),
          "nothing was sent to hold the worker open, so the browser is free to discard it"
        );
        assert.ok(
          calls.timers.filter(Boolean).length > 0,
          "the keepalive fired once and never re-armed"
        );
      });

      test("stops holding the worker open once the backend is gone", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.onNativeDisconnect();
        calls.toNativeHost.length = 0;

        runTimers(calls);

        assert.ok(
          !calls.toNativeHost.some((m) => m.cmd === "get-status"),
          "kept talking to a port that is not there"
        );
      });

      // Storage does refuse, with nothing where the answer should be. Reading
      // a field off that threw, and the throw took out everything the callback
      // had left to do — including the init without which the backend never
      // starts Tailscale. The popup then sat with a blank state line, waiting
      // on a backend that had been told to do nothing at all.
      test("survives storage refusing to answer", async () => {
        // Reading a field off the nothing storage hands back used to throw
        // right here, during the load, and the throw took the init with it.
        const { calls } = loadBackground(target.file, target.flavor, {}, { storageFailures: 1 });
        await flush();

        bringUp(calls); // a message is itself another chance at the read
        await flush();

        assert.ok(
          calls.toNativeHost.some((m) => m.cmd === "init"),
          "the backend was never told to start Tailscale, so it never would have"
        );
      });

      test("keeps asking while storage keeps refusing", async () => {
        const { calls } = loadBackground(target.file, target.flavor, {}, { storageFailures: 2 });
        await flush();
        bringUp(calls); // the second refusal is spent here
        await flush();
        assert.ok(!calls.toNativeHost.some((m) => m.cmd === "init"), "sanity: nothing to init with yet");

        runTimers(calls); // the retry it scheduled
        await flush();

        assert.ok(
          calls.toNativeHost.some((m) => m.cmd === "init"),
          "gave up on storage, leaving the backend idle for the life of the worker"
        );
      });

      test("never uses a profile id that storage would not keep", async () => {
        // The id names the tsnet state directory. One that did not stick is a
        // different machine on the tailnet, logged out, at the next start.
        const { calls } = loadBackground(
          target.file,
          target.flavor,
          {},
          { storage: {}, storageWriteFailures: 1 } // nothing saved yet, and the write refuses
        );
        await flush(); // the first id is made, and the write refuses it
        bringUp(calls); // another go: a second id, and this write lands
        await flush();

        const init = calls.toNativeHost.find((m) => m.cmd === "init");
        assert.ok(init, "never recovered once storage started accepting writes");
        assert.equal(
          init.initID,
          calls.storage.profileId,
          "inited with an id storage never kept — the next start would make another one, " +
            "and the tailnet would see a new machine every time"
        );
      });

      test("its manifest asks for what the reconnect needs", async () => {
        const fs = await import("node:fs");
        const dir = path.dirname(target.file);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

        for (const perm of ["alarms", "idle", "storage", "nativeMessaging"]) {
          assert.ok(
            (manifest.permissions ?? []).includes(perm),
            `the script uses ${perm}, which the manifest does not ask for — it throws on load without it`
          );
        }
      });
    });

    // Which state the extension comes back in is the backend's to say. Its
    // preferences are on disk, so it returns connected or switched off exactly
    // as the user left it; this script's own state lives in a worker the
    // browser throws away.
    describe("state after a reconnect", () => {
      test("a port on its own is not a reason to route anything", () => {
        const { calls } = loadBackground(target.file, target.flavor);

        calls.onNativeMessage({ procRunning: { port: 41234 } });

        assert.ok(
          !target.isProxied(calls),
          "routed the browser before the backend had said a word about its state"
        );
      });

      // The browser keeps its proxy setting across a restart of the background
      // script, so between a wake and the new backend reaching Running it is
      // still addressing the port the last one listened on — where nothing
      // answers. And with an exit node configured, anything that does get out
      // in that window leaves from this machine's own address. Both are why
      // "not running yet" is not a reason to stand aside: the new backend
      // refuses to dial until it is safe, which is the failure we want.
      test("routes at a backend that is still coming up", () => {
        const { calls } = loadBackground(target.file, target.flavor);

        calls.onNativeMessage({ procRunning: { port: 41234 } });
        calls.onNativeMessage({ status: { running: false, error: "State: Starting" } });

        assert.ok(
          target.isProxied(calls),
          "left the browser out of the proxy while the backend was starting"
        );
      });

      test("moves to the new port when the backend has been replaced", () => {
        const { sandbox, calls } = loadBackground(target.file, target.flavor);
        bringUp(calls, 41234);
        calls.onNativeDisconnect();
        runTimers(calls);

        // The replacement listens somewhere else: the kernel picks the port.
        calls.onNativeMessage({ procRunning: { port: 41235 }, status: { running: true } });

        assert.ok(target.isProxied(calls), "the browser is not going through the new backend");
        assert.equal(
          sandbox.lastProxyPort,
          41235,
          "still addressing the port the backend that died was listening on"
        );
      });

      test("leaves a profile that was switched off switched off", () => {
        const { calls } = loadBackground(target.file, target.flavor);

        calls.onNativeMessage({ procRunning: { port: 41234 } });
        calls.onNativeMessage({ status: { running: false, error: "State: Stopped" } });

        assert.ok(
          !target.isProxied(calls),
          "switched the tailnet back on for a profile the user had switched off"
        );
      });

      test("routes the browser again once the backend reports it is running", () => {
        const { calls } = loadBackground(target.file, target.flavor);

        calls.onNativeMessage({ procRunning: { port: 41234 } });
        calls.onNativeMessage({ status: { running: true, tailnet: "test@example.com" } });

        assert.ok(target.isProxied(calls), "the backend is up and the browser is not going through it");
      });

      test("hands browsing back when the backend stops routing", () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        calls.toNativeHost.length = 0;

        calls.onNativeMessage({ status: { running: false, error: "State: Stopped" } });

        assert.ok(!target.isProxied(calls), "left the browser pointed at a backend that is not routing");
        assert.ok(
          !calls.toNativeHost.some((m) => m.cmd === "down"),
          "answered the backend's own report by switching it off, which would still be off after the next restart"
        );
      });

      // "Not running yet" is what the first seconds of a connection look like.
      // Reading that as "the user wants this off" would drop the proxy under
      // someone who has just switched it on.
      test("keeps the proxy while the connection the user asked for comes up", async () => {
        const { calls } = loadBackground(target.file, target.flavor);
        bringUp(calls);
        await sendCommand(calls, { command: "toggleProxy" }); // off
        await sendCommand(calls, { command: "toggleProxy" }); // and on again
        assert.ok(target.isProxied(calls), "expected to be proxied after switching back on");

        calls.onNativeMessage({ status: { running: false, error: "State: Starting" } });

        assert.ok(target.isProxied(calls), "dropped the proxy while the tailnet was still starting");
      });
    });

    // The backend reports a failed start in procRunning.error and a failed
    // init in init.error. Both branches used to read a field that has never
    // existed — "errror", and "err" — so the first never ran at all and the
    // second logged "undefined" in place of the reason.
    test("acts on a backend that reports it could not start", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);
      assert.ok(target.isProxied(calls), "expected to be proxied to begin with");

      calls.onNativeMessage({ procRunning: { error: "listen tcp 127.0.0.1:0: too many open files" } });

      assert.ok(
        !target.isProxied(calls),
        "left the browser routed through a backend that says it never came up"
      );
    });

    test("acts on a backend that reports a failed init", () => {
      const { calls } = loadBackground(target.file, target.flavor);
      bringUp(calls);

      calls.onNativeMessage({ init: { error: "starting tsnet.Server: permission denied" } });

      assert.ok(!target.isProxied(calls), "left the browser routed into a tailnet that never started");
    });

    // This fork's native host understands set-exit-node and reports exitNodes;
    // upstream's does not. Pointing people at the wrong module hands them a
    // host that half-works, with no hint as to why, so pin it to this repo.
    test("the install prompt installs this fork, not upstream", () => {
      const { calls } = loadBackground(target.file, target.flavor);
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
