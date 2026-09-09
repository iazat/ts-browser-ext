// End-to-end: the real Chrome extension, in a real Chromium, talking to the
// real native host over native messaging — then the host is killed the way a
// crash would, and the extension has to recover on its own.
//
// This is the scenario the unit suites can only imitate: a replacement host
// is a fresh process that has to be sent init again, and the browser's proxy
// setting has to be re-pointed at the port it reports. Both used to be missed,
// and the browser sat on a dead proxy with the popup reading "Connecting…".
//
// It is not part of `npm test`: it builds the Go backend, needs Linux paths
// for Chromium's native messaging registration, and takes a network that at
// least lets tsnet try to reach the control plane. Run it by hand:
//
//   npm run test:e2e
//
// Environment: CHROMIUM_PATH points at a Chromium binary when playwright's is
// not installed; EXT_DIR and HOST_BIN override the extension directory and
// backend binary, so a build of an older commit can be checked against the
// same script.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.EXT_DIR || ROOT;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tailext-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let BIN = process.env.HOST_BIN;
if (!BIN) {
  BIN = path.join(work, "ts-browser-ext");
  log("building the backend");
  execFileSync("go", ["build", "-o", BIN, "."], { cwd: ROOT, stdio: "inherit" });
}

// The host's stderr would otherwise vanish into Chromium's; keep it.
const hostLog = path.join(work, "host.log");
const wrapper = path.join(work, "host.sh");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec 2>>"${hostLog}"\nexec "${BIN}" "$@"\n`, { mode: 0o755 });

// hostPids lists the running backends spawned for this run. The argument
// Chromium passes — the extension origin — is what tells them from anything
// else called ts-browser-ext.
const hostPids = () => {
  try {
    return execFileSync("pgrep", ["-f", `${BIN} chrome-extension://`]).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const userDataDir = path.join(work, "profile");
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  // Chromium reads the proxy environment; the point here is the proxy the
  // extension sets, so keep the environment's out of the way.
  env: { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*", no_proxy: "*" },
});

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;
log("extension id", id);

// Register the host for this extension id, as --install does. On Linux,
// Chromium looks for user-level registrations under its user data directory.
const regDir = path.join(userDataDir, "NativeMessagingHosts");
fs.mkdirSync(regDir, { recursive: true });
fs.writeFileSync(
  path.join(regDir, "io.github.iazat.tailext.chrome.json"),
  JSON.stringify({
    name: "io.github.iazat.tailext.chrome",
    description: "TailExt native backend",
    path: wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  })
);

const state = () =>
  sw.evaluate(() => ({
    deadPort,
    didInit,
    nativeProxyPort,
    needsLogin: !!(lastStatus && lastStatus.needsLogin),
    error: lastStatus && lastStatus.error,
  }));
const proxy = () => sw.evaluate(() => new Promise((r) => chrome.proxy.settings.get({}, (v) => r(v.value))));
const until = async (pred, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    const s = await state();
    if (pred(s)) return s;
    await sleep(200);
  }
  return state();
};

// The worker connected before the registration existed and is backing off;
// give it the nudge a browser start would.
await sw.evaluate(() => connectToNativeHost());
const first = await until((s) => s.needsLogin || s.error === undefined && s.didInit && !s.deadPort);
log("first host:", first, "proxy:", JSON.stringify(await proxy()));
const firstPids = hostPids();
log("host processes:", firstPids.length);

const page = await ctx.newPage();
const mgmt = await page.goto("http://100.100.100.100/", { timeout: 15000 });
log("management page:", mgmt.status(), await page.title());

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 420 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await sleep(800);
log("popup:", (await popup.textContent("#state")).trim());
await popup.screenshot({ path: path.join(work, "popup-before.png") });

log("killing host", firstPids.join(","), "with SIGKILL");
for (const pid of firstPids) execFileSync("kill", ["-9", pid]);

const dead = await until((s) => s.deadPort, 50);
log("after kill:", dead, "proxy:", JSON.stringify(await proxy()));
await sleep(300);
const duringText = (await popup.textContent("#state")).trim();
log("popup:", duringText);
await popup.screenshot({ path: path.join(work, "popup-during.png") });

const second = await until((s) => !s.deadPort && s.didInit && s.nativeProxyPort && s.nativeProxyPort !== first.nativeProxyPort && s.needsLogin);
const secondPids = hostPids();
log("second host:", second, "proxy:", JSON.stringify(await proxy()), "pids:", secondPids.join(","));
await sleep(500);
log("popup:", (await popup.textContent("#state")).trim());
await popup.screenshot({ path: path.join(work, "popup-after.png") });
const mgmt2 = await page.reload({ timeout: 15000 });
log("management page after restart:", mgmt2.status());

const checks = {
  "first host was initialised": first.didInit && !first.deadPort,
  "only one host was running": firstPids.length === 1,
  "the kill was noticed": dead.deadPort,
  // The once-only flag has to be reset, or the replacement is never sent init
  // and sits without tsnet; and the dead host's status must not be shown as
  // the new one's.
  "init was re-sent to the replacement": dead.didInit === false,
  "the dead host's status was dropped": !dead.needsLogin,
  "popup said it was reconnecting": /Reconnecting/.test(duringText),
  "replacement host was initialised": second.didInit && !second.deadPort && second.needsLogin,
  "proxy was re-pointed at the new port": (await proxy()).rules?.singleProxy?.port === second.nativeProxyPort && second.nativeProxyPort !== first.nativeProxyPort,
  "replacement is a different process": secondPids.length === 1 && secondPids[0] !== firstPids[0],
  "management page is served by the replacement": mgmt2.status() === 200,
};
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  log(pass ? "PASS" : "FAIL", name);
  ok &&= pass;
}
log(ok ? "E2E OK" : "E2E FAILED", "— artifacts in", work);

await ctx.close();
for (const pid of hostPids()) execFileSync("kill", ["-9", pid]);
process.exit(ok ? 0 : 1);
