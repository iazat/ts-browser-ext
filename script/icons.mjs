// Generates every icon the two extensions use, from one definition.
//
//   npm run icons
//
// The mark appears in six places per extension — four manifest sizes, three
// toolbar states, and inline in the popup header — so hand-editing colours
// means six chances to miss one, twice over. Everything below is derived from
// PALETTE and GEOMETRY, and the popup's inline copy is rewritten in place.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Colours per connection state. Only these change between states — the shapes
// stay put, so the toolbar icon does not appear to morph as the link comes up.
// Offline deliberately inverts: the field goes green and the shapes go dark,
// rather than the arrows simply dimming. It reads as "off" at a glance even
// when the icon is too small to make out what the shapes are.
const PALETTE = {
  online: { bg: "#0A1409", dot: "#2D473C", arrow: "#6FF25E" },
  offline: { bg: "#37533F", dot: "#071007", arrow: "#071007" },
  "need-install": { bg: "#0A1409", dot: "#4A3620", arrow: "#F0A03E" },
};

// Three arrows converging on the centre of a nine-cell grid, on a 1024 canvas.
const GEOMETRY = {
  radius: 232,
  dots: [
    [225, 222], [512, 222], [800, 222],
    [225, 800], [800, 800],
  ],
  dotRadius: 106,
  arrows: [
    "M132 417 H352 L444 512 L352 607 H132 Z", // pointing right
    "M892 417 H672 L580 512 L672 607 H892 Z", // pointing left
    "M417 892 V672 L512 580 L607 672 V892 Z", // pointing up
  ],
};

// `simple` drops the dots and enlarges the arrows. At 16px the full drawing
// gives each of its nine elements under five pixels and they smear together,
// so the smallest slot gets the idea rather than the detail.
function svg({ bg, dot, arrow }, { simple = false, attrs = "" } = {}) {
  const g = GEOMETRY;
  const dots = g.dots
    .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${g.dotRadius}"/>`)
    .join("");
  const scale = simple
    ? ' transform="translate(512 512) scale(1.42) translate(-512 -512)"'
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"${attrs}>
  <rect width="1024" height="1024" rx="${g.radius}" fill="${bg}"/>
${simple ? "" : `  <g fill="${dot}">${dots}</g>\n`}  <g fill="${arrow}" stroke="${arrow}" stroke-width="24" stroke-linejoin="round"${scale}>
    ${g.arrows.map((d) => `<path d="${d}"/>`).join("\n    ")}
  </g>
</svg>`;
}

// The popup carries the mark inline rather than as a file, so it survives with
// no network and no extra request. Rewrite that block instead of trusting
// whoever changes the palette to remember it.
function updatePopups(markup) {
  const indented = markup
    .split("\n")
    .map((line, i) => (i === 0 ? line : "        " + line))
    .join("\n");
  // Matched by attribute rather than by position: this script emits the tag
  // with class="mark" partway along, so anchoring on "<svg class=" made the
  // first run succeed and every run after it fail to find its own output.
  const MARK = /<svg\b[^>]*\bclass="mark"[^>]*>[\s\S]*?<\/svg>/;

  for (const dir of [ROOT, path.join(ROOT, "firefox")]) {
    const file = path.join(dir, "popup.html");
    const s = fs.readFileSync(file, "utf8");
    if (!MARK.test(s)) throw new Error(`no inline mark found in ${file}`);
    fs.writeFileSync(file, s.replace(MARK, indented));
  }
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);

async function png(markup, size, out) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`
  );
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
}

for (const dir of [ROOT, path.join(ROOT, "firefox")]) {
  fs.mkdirSync(path.join(dir, "icons"), { recursive: true });

  await png(svg(PALETTE.online, { simple: true }), 16, path.join(dir, "icons/icon16.png"));
  for (const size of [32, 48, 128]) {
    await png(svg(PALETTE.online), size, path.join(dir, `icons/icon${size}.png`));
  }

  await png(svg(PALETTE.online), 128, path.join(dir, "icon.png"));
  for (const [state, palette] of Object.entries(PALETTE)) {
    await png(svg(palette), 128, path.join(dir, `${state}.png`));
  }

  fs.writeFileSync(path.join(dir, "icons/icon.svg"), svg(PALETTE.online) + "\n");
}

updatePopups(svg(PALETTE.online, { attrs: ' class="mark" aria-hidden="true"' }));

await browser.close();
console.log("icons regenerated for both extensions, popups updated");
