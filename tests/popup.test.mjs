// Renders both popups in a real browser engine and drives them through the
// states the background script can put them in.
//
// This runs in Chromium even for the Firefox copy: the markup, the CSS and
// popup.js's own logic are the parts under test here, and those are the same
// code in both. It does not cover Firefox's proxy or native-messaging
// integration, which needs a real Firefox.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { name: "chrome", dir: ROOT, api: "chrome" },
  { name: "firefox", dir: path.join(ROOT, "firefox"), api: "browser" },
];

// Stands in for the background script on the other end of the popup's port.
// __push() delivers a message the way the background would; __sent collects
// everything the popup tried to send back.
const backgroundStub = (api) => `
  window.__sent = [];
  let onMsg = null;
  window.__push = (m) => onMsg && onMsg(m);
  window.${api} = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (f) => (onMsg = f) },
        disconnect: () => {},
      }),
      sendMessage: (m, cb) => {
        window.__sent.push(m);
        const reply = { status: "Disconnected" };
        if (typeof cb === "function") { cb(reply); return undefined; }
        return Promise.resolve(reply);
      },
    },
    tabs: { create: (o) => window.__sent.push({ tabCreate: o.url }) },
    storage: {
      local: {
        get: (keys, cb) => {
          const v = window.__cached ? { lastStatus: window.__cached } : {};
          if (typeof cb === "function") { cb(v); return undefined; }
          return Promise.resolve(v);
        },
      },
    },
  };
`;

const CONNECTED = {
  status: {
    running: true,
    tailnet: "test@example.com",
    exitNode: "nyc.tail1234.ts.net",
    exitNodes: [
      { name: "nyc.tail1234.ts.net", online: true },
      { name: "fra.tail1234.ts.net", online: true },
      { name: "old-box.tail1234.ts.net", online: false },
    ],
  },
};

let chromium, browser;

before(async () => {
  ({ chromium } = await import("playwright"));
  // The sandbox ships a prebuilt Chromium that may not match playwright's
  // pinned revision; honour an explicit path when one is set.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});

after(async () => {
  await browser?.close();
});

// open loads a popup with the background stubbed out, blocks every non-local
// request, and hands back the page plus anything it tried to fetch remotely.
async function open(target, message) {
  const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
  const remote = [];
  const failures = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith("file://")) {
      remote.push(url);
      return route.abort();
    }
    route.continue();
  });
  page.on("pageerror", (e) => failures.push(String(e.message)));
  await page.addInitScript(backgroundStub(target.api));
  await page.goto("file://" + path.join(target.dir, "popup.html"));
  if (message) await page.evaluate((m) => window.__push(m), message);
  await page.waitForFunction(() => document.readyState === "complete");
  return { page, remote, failures };
}

for (const target of TARGETS) {
  describe(`${target.name}: popup`, () => {
    test("renders without reaching the network", async () => {
      const { page, remote, failures } = await open(target, CONNECTED);
      assert.deepEqual(
        remote,
        [],
        "the popup must not fetch anything remote — that reports every popup open to a third party and breaks the UI offline"
      );
      assert.deepEqual(failures, []);
      await page.close();
    });

    test("uses the bundled Inter, not a fallback", async () => {
      const { page } = await open(target, CONNECTED);
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family)
      );
      assert.ok(loaded.includes("Inter"), `no Inter face loaded from disk, got ${JSON.stringify(loaded)}`);
      await page.close();
    });

    test("lists exit nodes, shortened and marked offline", async () => {
      const { page } = await open(target, CONNECTED);
      const opts = await page.$$eval("#exitNodeSelect option", (os) =>
        os.map((o) => ({ label: o.textContent, value: o.value, selected: o.selected }))
      );
      assert.equal(opts.length, 4, "expected None plus three nodes");
      assert.equal(opts[0].label, "None");
      assert.ok(opts.some((o) => o.label === "nyc"), "FQDN should be shortened to the machine name");
      assert.ok(opts.some((o) => o.label === "old-box (offline)"));
      assert.equal(opts.find((o) => o.selected).value, "nyc.tail1234.ts.net");
      await page.close();
    });

    test("choosing an exit node tells the background", async () => {
      const { page } = await open(target, CONNECTED);
      await page.selectOption("#exitNodeSelect", "fra.tail1234.ts.net");
      const sent = await page.evaluate(() => window.__sent);
      const msg = sent.find((s) => s.command === "setExitNode");
      assert.ok(msg, "no setExitNode was sent");
      assert.equal(msg.exitNode, "fra.tail1234.ts.net");
      await page.close();
    });

    test("names the tailnet it is connected to", async () => {
      const { page } = await open(target, CONNECTED);
      const text = (await page.textContent("#state")).trim();
      assert.equal(text, "Connected as test@example.com");
      await page.close();
    });

    // The backend can report running before it knows the tailnet name — it did
    // exactly that when the netmap had not arrived yet — and the popup used to
    // fill the gap with "Not connected", producing "Connected as Not
    // connected" on a session that was in fact up and routing.
    test("says plain Connected when the tailnet name is missing", async () => {
      const { page } = await open(target, { status: { running: true, tailnet: "" } });
      const text = (await page.textContent("#state")).trim();
      assert.equal(text, "Connected");
      assert.ok(!/Not connected/.test(text), `contradicts itself: ${JSON.stringify(text)}`);
      await page.close();
    });

    // The backend reports exitNodeResolving when it has a selection it cannot
    // name yet, which is what the first seconds after switching on look like.
    // Rendering None there tells the user their exit node was forgotten.
    test("says it is still working out the exit node rather than None", async () => {
      const { page } = await open(target, {
        status: { ...CONNECTED.status, exitNode: "", exitNodeResolving: true },
      });
      const opts = await page.$$eval("#exitNodeSelect option", (os) =>
        os.map((o) => o.textContent)
      );
      assert.ok(
        !opts.includes("None"),
        `claimed no exit node is configured while still resolving: ${JSON.stringify(opts)}`
      );
      assert.deepEqual(opts, ["Connecting…"]);
      assert.equal(
        await page.$eval("#exitNodeSelect", (e) => e.disabled),
        true,
        "the picker must not accept a change while it cannot show the current value"
      );
      await page.close();
    });

    // A status arrives every few seconds. Rebuilding the picker's options
    // under an open menu made the browser commit whatever ended up at the
    // clicked position when the menu closed — None — and that went to the
    // backend as "stop using an exit node" from a user who touched nothing.
    test("leaves the picker alone while the user is in it", async () => {
      const { page } = await open(target, CONNECTED);
      await page.focus("#exitNodeSelect");
      const before = await page.$eval("#exitNodeSelect", (e) => e.value);

      await page.evaluate((m) => window.__push(m), {
        status: { ...CONNECTED.status, exitNode: "fra.tail1234.ts.net" },
      });
      assert.equal(
        await page.$eval("#exitNodeSelect", (e) => e.value),
        before,
        "the picker was rebuilt under the user's hands"
      );

      // Once they leave it, the deferred status is rendered.
      await page.evaluate(() => document.getElementById("exitNodeSelect").blur());
      assert.equal(await page.$eval("#exitNodeSelect", (e) => e.value), "fra.tail1234.ts.net");
      await page.close();
    });

    test("does not rebuild the picker when nothing changed", async () => {
      const { page } = await open(target, CONNECTED);
      await page.$eval("#exitNodeSelect", (e) => (e.options[0].marker = "kept"));
      await page.evaluate((m) => window.__push(m), CONNECTED);
      assert.equal(
        await page.$eval("#exitNodeSelect", (e) => e.options[0].marker),
        "kept",
        "an identical status replaced the picker's options"
      );
      await page.close();
    });

    test("re-enables the picker once the exit node is known", async () => {
      const { page } = await open(target, CONNECTED);
      assert.equal(await page.$eval("#exitNodeSelect", (e) => e.disabled), false);
      await page.close();
    });

    test("hides the exit node picker when there is nothing to pick", async () => {
      const { page } = await open(target, { status: { running: false } });
      assert.equal(
        await page.isVisible("#exitNodeRow"),
        false,
        "an empty picker is showing; .exit-node's display:flex beats the [hidden] attribute unless a rule says otherwise"
      );
      await page.close();
    });

    test("the login link opens the auth URL instead of navigating the popup", async () => {
      const url = "https://login.tailscale.com/a/abc123";
      const { page } = await open(target, { status: { needsLogin: true, browseToURL: url } });
      await page.click("#loginLink");
      const sent = await page.evaluate(() => window.__sent);
      assert.ok(sent.some((s) => s.tabCreate === url), "clicking Log in did not open a tab");
      assert.equal(await page.evaluate(() => location.hash), "", "the popup navigated instead of opening a tab");
      await page.close();
    });

    test("shows transient states rather than raw errors", async () => {
      for (const [error, expected] of [
        ["State: Starting", "Connecting"],
        ["State: NoState", "Connecting"],
        ["State: NeedsMachineAuth", "Waiting for approval"],
        ["State: Stopped", "Disconnected"],
      ]) {
        const { page } = await open(target, { status: { error } });
        const text = (await page.textContent("#state")).trim();
        assert.ok(text.includes(expected), `for ${error} expected ${expected}, got ${JSON.stringify(text)}`);
        await page.close();
      }
    });

    test("a genuine error is still surfaced", async () => {
      const { page } = await open(target, { status: { error: "something broke" } });
      const text = await page.textContent("#state");
      assert.ok(text.includes("something broke"));
      await page.close();
    });

    test("the install command wraps and hides the settings button", async () => {
      const cmd = "go run github.com/tailscale/ts-browser-ext@main --install=Fabcdefghijklmnopqrstuvwx";
      const { page } = await open(target, { installCmd: cmd });
      assert.ok((await page.textContent("#state")).includes("--install=F"));
      assert.equal(await page.isVisible("#settingsButton"), false);
      const overflows = await page.evaluate(() => {
        const pre = document.querySelector("#state pre");
        return pre.scrollWidth > pre.clientWidth + 1;
      });
      assert.equal(overflows, false, "the install command overflows its box instead of wrapping");
      await page.close();
    });

    // The background reports a host that answered and then went away as
    // reconnecting. That is not a missing install and not an error: the
    // popup waits, with the toggle disabled, since there is nothing to toggle.
    test("says it is reconnecting, without an install command", async () => {
      const { page } = await open(target, { reconnecting: true, error: "Native host has exited." });
      const text = (await page.textContent("#state")).trim();
      assert.ok(text.includes("Reconnecting"), `got ${JSON.stringify(text)}`);
      assert.ok(!text.includes("--install"), "asked for an install while reconnecting");
      // The toggle stays usable: a click is remembered by the background and
      // delivered to the backend that arrives.
      assert.equal(await page.$eval("#toggleSlider", (e) => e.disabled), false);
      assert.equal(await page.isVisible("#settingsButton"), false);
      await page.close();
    });

    // Opening the panel after a wake means a new backend starting Tailscale
    // from cold. The seconds spent blank read as broken; the last known
    // status is painted at once, under a spinner, until something live
    // arrives.
    test("paints the cached status before the background answers", async () => {
      const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
      await page.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
      await page.addInitScript(backgroundStub(target.api));
      await page.addInitScript((s) => (window.__cached = s), CONNECTED.status);
      await page.goto("file://" + path.join(target.dir, "popup.html"));
      await page.waitForFunction(() => document.readyState === "complete");
      const text = (await page.textContent("#state")).trim();
      assert.equal(text, "Connected as test@example.com");
      assert.ok((await page.getAttribute(".slider", "class")).includes("loading"), "the cached state was shown as confirmed");

      await page.evaluate((m) => window.__push(m), CONNECTED);
      assert.ok(!(await page.getAttribute(".slider", "class")).includes("loading"), "the live answer did not clear the spinner");
      await page.close();
    });

    test("the cache does not paint over a live answer", async () => {
      const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
      await page.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
      await page.addInitScript(backgroundStub(target.api));
      await page.addInitScript((api) => {
        // Storage that answers late, after the background has spoken.
        const orig = window[api].storage.local.get;
        window[api].storage.local.get = (k, cb) => {
          setTimeout(() => orig(k, cb), 50);
          return new Promise((r) => setTimeout(() => r({ lastStatus: window.__cached }), 50));
        };
        window.__cached = { running: true, tailnet: "stale" };
      }, target.api);
      await page.goto("file://" + path.join(target.dir, "popup.html"));
      await page.evaluate((m) => window.__push(m), { installCmd: "go run x --install=C1" });
      await page.waitForTimeout(150);
      const text = await page.textContent("#state");
      assert.ok(text.includes("--install=C1"), `the stale cache replaced the live install prompt: ${JSON.stringify(text)}`);
      await page.close();
    });

    test("the toggle sends the state it was switched to", async () => {
      const { page } = await open(target, CONNECTED); // switch is on
      await page.$eval("#toggleSlider", (e) => e.click()); // the input is drawn as a slider
      const sent = await page.evaluate(() => window.__sent);
      const msg = sent.find((s) => s.command === "toggleProxy");
      assert.ok(msg, "no toggleProxy was sent");
      assert.equal(msg.enable, false, "switched off, but asked for something else");
      await page.close();
    });

    test("an empty status reads as connecting, not as connected", async () => {
      const { page } = await open(target, { status: {} });
      const text = (await page.textContent("#state")).trim();
      assert.ok(text.includes("Connecting"), `got ${JSON.stringify(text)}`);
      await page.close();
    });

    test("re-enables the toggle once the backend is back", async () => {
      const { page } = await open(target, { reconnecting: true });
      await page.evaluate((m) => window.__push(m), CONNECTED);
      assert.equal(await page.$eval("#toggleSlider", (e) => e.disabled), false);
      assert.equal(await page.isVisible("#settingsButton"), true);
      await page.close();
    });

    // "Native host has exited" and "not found" both leave the popup asking
    // for an install, and the fix is different for each, so the browser's
    // reason is shown under the command rather than lost to the console.
    test("shows the browser's reason under the install command", async () => {
      const { page } = await open(target, {
        installCmd: "go run github.com/iazat/ts-browser-ext@latest --install=Fabc",
        error: "Native host has exited.",
      });
      const text = await page.textContent("#state");
      assert.ok(text.includes("--install=F"));
      assert.ok(text.includes("Native host has exited."), `reason missing from ${JSON.stringify(text)}`);
      await page.close();
    });

    test("the install command is shown as text, not markup", async () => {
      const { page } = await open(target, { installCmd: "<img src=x onerror=alert(1)>" });
      const imgs = await page.$$("#state img");
      assert.equal(imgs.length, 0, "the install command was inserted as HTML");
      await page.close();
    });

    test("the toggle reflects connection state", async () => {
      const on = await open(target, CONNECTED);
      const onClass = await on.page.getAttribute(".slider", "class");
      assert.ok(onClass.includes("connected"), `expected a connected slider, got ${onClass}`);
      await on.page.close();

      const off = await open(target, { status: { running: false } });
      const offClass = await off.page.getAttribute(".slider", "class");
      assert.ok(!offClass.includes("connected"), `expected a disconnected slider, got ${offClass}`);
      await off.page.close();
    });
  });
}

test("both popups stay byte-identical", async () => {
  const fs = await import("node:fs");
  const chrome = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
  const firefox = fs.readFileSync(path.join(ROOT, "firefox", "popup.html"), "utf8");
  assert.equal(
    firefox,
    chrome,
    "popup.html has drifted between the two extensions; a fix landed in only one of them"
  );
});
