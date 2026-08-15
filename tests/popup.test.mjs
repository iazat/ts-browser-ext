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
