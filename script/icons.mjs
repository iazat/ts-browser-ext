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
  online: { bg: "#021204", dot: "#224A33", arrow: "#2AFF43" },
  offline: { bg: "#224A33", dot: "#021204", arrow: "#021204" },
  "need-install": { bg: "#021204", dot: "#4A3822", arrow: "#FF9500" },
};

// The artwork as supplied: a 512 canvas, a rounded frame inset by 16, five
// discs, and three arrows converging on the centre. The arrow paths carry
// their own corner rounding, so they are kept verbatim rather than rebuilt.
const GEOMETRY = {
  frame: { inset: 16, size: 480, radius: 96 },
  dots: [[59, 59], [203, 59], [347, 59], [59, 347], [347, 347]],
  dotSize: 106,
  arrows: [
    // pointing up
    "M305.222 333.913C306.616 335.298 307.313 335.991 307.812 336.8C308.254 337.518 308.58 338.301 308.777 339.12C309 340.044 309 341.027 309 342.992L309 440.2C309 444.68 309 446.921 308.128 448.632C307.361 450.137 306.137 451.361 304.632 452.128C302.921 453 300.68 453 296.2 453L215.8 453C211.32 453 209.079 453 207.368 452.128C205.863 451.361 204.639 450.137 203.872 448.632C203 446.921 203 444.68 203 440.2L203 342.992C203 341.027 203 340.044 203.223 339.12C203.42 338.301 203.746 337.518 204.188 336.8C204.687 335.991 205.384 335.298 206.778 333.913L246.978 293.966C250.138 290.825 251.718 289.255 253.537 288.667C255.138 288.149 256.862 288.149 258.463 288.667C260.282 289.255 261.862 290.825 265.022 293.966L305.222 333.913Z",
    // pointing left
    "M333.913 206.778C335.298 205.384 335.991 204.687 336.8 204.188C337.518 203.746 338.301 203.42 339.12 203.223C340.044 203 341.027 203 342.992 203L440.2 203C444.68 203 446.921 203 448.632 203.872C450.137 204.639 451.361 205.863 452.128 207.368C453 209.079 453 211.32 453 215.8V296.2C453 300.68 453 302.921 452.128 304.632C451.361 306.137 450.137 307.361 448.632 308.128C446.921 309 444.68 309 440.2 309H342.992C341.027 309 340.044 309 339.12 308.777C338.301 308.58 337.518 308.254 336.8 307.812C335.991 307.313 335.298 306.616 333.913 305.222L293.966 265.022C290.825 261.862 289.255 260.282 288.667 258.463C288.149 256.862 288.149 255.138 288.667 253.537C289.255 251.718 290.825 250.138 293.966 246.978L333.913 206.778Z",
    // pointing right
    "M178.087 206.778C176.702 205.384 176.009 204.687 175.2 204.188C174.482 203.746 173.699 203.42 172.88 203.223C171.956 203 170.973 203 169.008 203L71.8 203C67.3196 203 65.0794 203 63.3681 203.872C61.8628 204.639 60.6389 205.863 59.8719 207.368C59 209.079 59 211.32 59 215.8L59 296.2C59 300.68 59 302.921 59.8719 304.632C60.6389 306.137 61.8628 307.361 63.3681 308.128C65.0794 309 67.3196 309 71.8 309H169.008C170.973 309 171.956 309 172.88 308.777C173.699 308.58 174.482 308.254 175.2 307.812C176.009 307.313 176.702 306.616 178.087 305.222L218.034 265.022C221.175 261.862 222.745 260.282 223.333 258.463C223.851 256.862 223.851 255.138 223.333 253.537C222.745 251.718 221.175 250.138 218.034 246.978L178.087 206.778Z",
  ],
};

// `simple` drops the dots and enlarges the arrows. At 16px the full drawing
// gives each of its nine elements under five pixels and they smear together,
// so the smallest slot gets the idea rather than the detail.
function svg({ bg, dot, arrow }, { simple = false, attrs = "" } = {}) {
  const g = GEOMETRY;
  const f = g.frame;
  const dots = g.dots
    .map(
      ([x, y]) =>
        `<rect x="${x}" y="${y}" width="${g.dotSize}" height="${g.dotSize}" rx="${g.dotSize / 2}" fill="${dot}"/>`
    )
    .join("\n  ");
  const scale = simple
    ? ' transform="translate(256 256) scale(1.4) translate(-256 -256)"'
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none"${attrs}>
  <rect x="${f.inset}" y="${f.inset}" width="${f.size}" height="${f.size}" rx="${f.radius}" fill="${bg}"/>
${simple ? "" : `  ${dots}\n`}  <g fill="${arrow}"${scale}>
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

export const SIZES = [16, 32, 48, 128];

for (const dir of [ROOT, path.join(ROOT, "firefox")]) {
  fs.mkdirSync(path.join(dir, "icons"), { recursive: true });

  // A full set per state. The browser draws the toolbar at 16 and picks the
  // nearest size on offer, so handing it only a 128 leaves it downscaling
  // artwork with nine elements in it — which is mush at that size.
  for (const [state, palette] of Object.entries(PALETTE)) {
    for (const size of SIZES) {
      await png(
        svg(palette, { simple: size <= 16 }),
        size,
        path.join(dir, `icons/${state}-${size}.png`)
      );
    }
  }

  fs.writeFileSync(path.join(dir, "icons/icon.svg"), svg(PALETTE.online) + "\n");
}

updatePopups(svg(PALETTE.online, { attrs: ' class="mark" aria-hidden="true"' }));

await browser.close();
console.log("icons regenerated for both extensions, popups updated");
