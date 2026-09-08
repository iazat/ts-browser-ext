// Drives the real extension in a real browser against a stand-in backend.
//
// Everything else in this suite mocks the browser, and mocks are exactly where
// this branch's bugs were invisible: a port that is the same object on every
// connect, storage that always answers, timers that only fire when a test says
// so, and a worker that is never discarded. What that leaves untested is the
// case the extension exists to survive — the browser starting the backend,
// the backend dying underneath it, and the extension bringing one back.
//
// So this launches Chromium with the extension loaded, registers a native
// messaging host that answers the same protocol as the Go one, and kills it.
// The whole thing lives in a throwaway profile directory: nothing is written
// to the machine's browser configuration.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// unpackedExtensionId is how Chrome names an unpacked extension: the first
// half of the SHA-256 of its absolute path, with each hex digit shifted into
// a-p. Knowing it up front is what lets the native messaging registration —
// which has to name the extension it will talk to — be written before launch.
function unpackedExtensionId(dir) {
  return crypto
    .createHash("sha256")
    .update(dir)
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (d) => String.fromCharCode(97 + parseInt(d, 16)));
}

describe("chrome: end to end, against a stand-in backend", () => {
  test("brings a backend back by itself after one dies", async (t) => {
    if (process.platform === "win32") {
      t.skip("the native messaging registration here is written for unix");
      return;
    }
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      t.skip("playwright is not installed");
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tailext-e2e-"));
    const hostLog = path.join(tmp, "backend.log");
    const pidFile = path.join(tmp, "backend.pids");
    fs.writeFileSync(hostLog, "");
    fs.writeFileSync(pidFile, "");

    // The registration has to point at something executable, so wrap the
    // script in a one-line launcher that uses this same node.
    const launcher = path.join(tmp, "backend.sh");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HERE, "fake-backend.mjs"))}\n`
    );
    fs.chmodSync(launcher, 0o755);

    const userDataDir = path.join(tmp, "profile");
    const hostsDir = path.join(userDataDir, "NativeMessagingHosts");
    fs.mkdirSync(hostsDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostsDir, "io.github.iazat.tailext.chrome.json"),
      JSON.stringify({
        name: "io.github.iazat.tailext.chrome",
        description: "stand-in backend for the end to end test",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${unpackedExtensionId(ROOT)}/`],
      })
    );

    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
          "--headless=new",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`,
          "--no-sandbox",
        ],
        env: {
          ...process.env,
          FAKE_BACKEND_LOG: hostLog,
          FAKE_BACKEND_PIDS: pidFile,
          FAKE_BACKEND_PORT: "41234",
        },
      });
    } catch (err) {
      t.skip(`could not launch a browser with extensions: ${err.message}`);
      return;
    }

    try {
      const sw =
        ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));

      // Reading the background script's own variables is the point: it says
      // what the extension believes, which is what the branch changed.
      const state = () =>
        sw.evaluate(() => ({
          deadPort,
          didInit,
          proxyEnabled,
          lastProxyPort,
          tailnet: lastStatus && lastStatus.tailnet,
        }));
      const until = async (pred, what, ms = 30000) => {
        const deadline = Date.now() + ms;
        let last;
        while (Date.now() < deadline) {
          last = await state().catch(() => null);
          if (last && pred(last)) return last;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.fail(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
      };

      const up = await until(
        (s) => !s.deadPort && s.didInit && s.proxyEnabled,
        "the backend to connect, be initialised, and be routed through"
      );
      assert.equal(up.tailnet, "fake.example");
      assert.equal(up.lastProxyPort, 41234);

      // The popup reads its state from the background, and from storage before
      // the background answers. Either way it must say something.
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${unpackedExtensionId(ROOT)}/popup.html`);
      await page.waitForFunction(
        () => document.querySelector("#state")?.textContent?.trim().length > 0,
        null,
        { timeout: 10000 }
      );
      assert.equal((await page.textContent("#state")).trim(), "Connected as fake.example");
      await page.close();

      // Now the case this all exists for: the backend goes away underneath it,
      // as it does when a sleeping machine takes the worker down with it.
      const pids = fs.readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(pids.length, 1, `expected one backend so far, saw ${pids.length}`);
      process.kill(Number(pids[0]), "SIGKILL");

      const lost = await until((s) => s.deadPort, "the extension to notice the backend is gone");
      assert.equal(
        lost.proxyEnabled,
        false,
        "browsing was left pointed at a proxy port with nothing behind it"
      );

      const back = await until(
        (s) => !s.deadPort && s.didInit && s.proxyEnabled,
        "the extension to bring a backend back on its own",
        60000
      );
      assert.equal(back.tailnet, "fake.example");

      const log = fs.readFileSync(hostLog, "utf8");
      const inits = log.split("\n").filter((l) => l.includes('"cmd":"init"'));
      assert.equal(inits.length, 2, `each backend must be initialised; got ${inits.length}`);
      const ids = inits.map((l) => JSON.parse(l.slice(l.indexOf("{"))).initID);
      assert.equal(
        ids[0],
        ids[1],
        "the replacement was initialised under a different profile id — that is a different " +
          "machine on the tailnet, logged out, with the old one's state stranded on disk"
      );
      assert.equal(
        fs.readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).length,
        2,
        "expected exactly one replacement backend, not several"
      );
    } finally {
      await ctx.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
