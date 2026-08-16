// Captures the store listing screenshots.
//
//   npm run screenshots        # writes dist/screenshots/*.png at 1280x800
//
// The extension is loaded into a real browser rather than the popup being
// opened as a file:// page, so what is captured is the actual extension: its
// own chrome-extension:// origin, its bundled font, its real manifest. The
// background script is stubbed, because the interesting states — connected,
// an exit node chosen — need a tailnet that a screenshot run cannot have.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "screenshots");

// Stands in for the background script on the other end of the popup's port.
const STUB = `
  window.__push = (m) => window.__handler && window.__handler(m);
  window.chrome = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (f) => (window.__handler = f) },
        disconnect: () => {},
      }),
      sendMessage: (m, cb) => {
        const reply = { status: "Disconnected" };
        if (typeof cb === "function") { cb(reply); return undefined; }
        return Promise.resolve(reply);
      },
    },
    tabs: { create: () => {} },
  };
`;

const NODES = [
  { name: "fra-relay.tail1234.ts.net", online: true },
  { name: "nyc-relay.tail1234.ts.net", online: true },
  { name: "old-laptop.tail1234.ts.net", online: false },
];

const SHOTS = [
  {
    file: "connected",
    caption: "One tailnet per browser profile",
    message: { status: { running: true, tailnet: "you@example.com", exitNode: "", exitNodes: NODES } },
  },
  {
    file: "exit-node",
    caption: "Pick an exit node for this profile alone",
    message: {
      status: {
        running: true,
        tailnet: "you@example.com",
        exitNode: "fra-relay.tail1234.ts.net",
        exitNodes: NODES,
      },
    },
  },
  {
    file: "disconnected",
    caption: "Off means off — the browser goes straight back to direct",
    message: { status: { running: false } },
  },
];

const frame = (dataUri, caption) => `
<style>
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden }
  body {
    background: linear-gradient(160deg, #faf7f6 0%, #eae4e1 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 44px;
  }
  h1 { margin: 0; font-size: 34px; font-weight: 500; color: #1f1e1e;
       letter-spacing: -0.02em; text-align: center; max-width: 900px }
  img { width: 664px; display: block; border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .18) }
</style>
<h1>${caption}</h1>
<img src="${dataUri}">`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tailext-shots-"));
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [
    "--headless=new",
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    "--no-sandbox",
  ],
});

const worker =
  context.serviceWorkers()[0] ||
  (await context.waitForEvent("serviceworker", { timeout: 30000 }));
const id = new URL(worker.url()).host;

fs.mkdirSync(OUT, { recursive: true });

for (const { file, caption, message } of SHOTS) {
  const popup = await context.newPage({ viewport: { width: 360, height: 620 } });
  await popup.addInitScript(STUB);
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate((m) => window.__push(m), message);
  await popup.evaluate(() => document.fonts.ready);
  await popup.waitForTimeout(200);
  const shot = await (await popup.$("body")).screenshot();
  await popup.close();

  // The popup is 332px wide; presenting it centred on the store's canvas beats
  // stretching it to 1280 or shipping a mostly-empty image.
  const page = await context.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(frame(`data:image/png;base64,${shot.toString("base64")}`, caption));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, `${file}-1280x800.png`) });
  await page.close();

  console.log(`dist/screenshots/${file}-1280x800.png`);
}

await context.close();
fs.rmSync(profile, { recursive: true, force: true });
