// Exercises both copies of background.js against a mocked WebExtension API.
//
// The two extensions are maintained as separate files, so anything that only
// gets fixed in one of them is a bug waiting to happen. Every behaviour that
// is supposed to be shared is asserted for both.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackground, connectPopup, sendCommand, plain } from "./webext-mock.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { name: "chrome", file: path.join(ROOT, "background.js"), flavor: "chrome" },
  { name: "firefox", file: path.join(ROOT, "firefox", "background.js"), flavor: "browser" },
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
      assert.equal(calls.nativeHostName, `com.tailscale.browserext.${target.name}`);
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
