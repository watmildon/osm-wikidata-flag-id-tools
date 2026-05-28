#!/usr/bin/env node
// Extract colors from flag SVGs and bucket them against our palette.
//
// For every flag whose Wikidata P18 is an SVG, download the SVG from Commons
// (cached on disk), scan it for fill/stroke colors via regex (no SVG parser
// dep — works on the text), map each found color to the nearest palette
// slug, and write the result as `svgColors` on the flag record. Unmappable
// colors are tracked in a diagnostic for future palette expansion.
//
// No area weighting in v1 — every paint color in the SVG counts, regardless
// of how much of the flag it covers. A future v2 could rasterize and weight
// by pixel area, but unweighted extraction is dependency-free and good
// enough as a first pass.
//
// What's NOT extracted:
//   - Gradients and patterns (very rare on flag SVGs)
//   - currentColor-style indirection (rare)
//   - Externally-referenced fills (never seen on Commons flag SVGs)
//
// Usage:
//   node scripts/extract-svg-colors.mjs               # all SVG flags
//   node scripts/extract-svg-colors.mjs --only=Q42537 # specific QIDs
//   node scripts/extract-svg-colors.mjs --dry         # report, don't write
//   node scripts/extract-svg-colors.mjs --force       # re-download cached SVGs
import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const CACHE_DIR = join(ROOT, "data", ".cache", "svg");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/; extract-svg-colors.mjs)";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
})();

// ---- palette ----
//
// Each palette slug has one or more reference RGB values. We compute the
// distance in Lab (perceptually meaningful) from the extracted color to
// each reference, and pick the slug with the closest reference. Multiple
// references per slug let us catch variant shades (e.g. crimson vs scarlet
// both bucket to "red").
//
// New buckets added in this script: gray, pink, darkblue.

const PALETTE_REFS = {
  red:       [[220, 38, 38],  [185, 28, 28],  [239, 68, 68],  [255, 0, 0]],
  white:     [[255, 255, 255], [248, 248, 248]],
  blue:      [[29, 78, 216],  [37, 99, 235],  [59, 130, 246], [0, 0, 255]],
  darkblue:  [[15, 23, 78],   [30, 41, 100],  [10, 25, 60]],
  lightblue: [[125, 211, 252], [56, 189, 248], [186, 230, 253]],
  green:     [[22, 163, 74],  [21, 128, 61],  [34, 197, 94],
              [85, 107, 47],  [34, 100, 50],  [107, 142, 35], // + olive, forest, olive-drab
              [0, 255, 0],    [0, 204, 0]],                   // + sRGB green primary
  yellow:    [[250, 204, 21], [234, 179, 8],  [253, 224, 71],
              [255, 255, 0],  [248, 236, 148], [241, 216, 158]], // + sRGB yellow, common heraldic creams
  black:     [[17, 24, 39],   [0, 0, 0],      [31, 41, 55]],
  orange:    [[234, 88, 12],  [249, 115, 22], [194, 65, 12], [241, 189, 137]], // + heraldic flesh-tan
  brown:     [[146, 64, 14],  [120, 53, 15],  [180, 83, 9],  [181, 140, 88]],  // + tan-brown
  purple:    [[126, 34, 206], [107, 33, 168], [147, 51, 234], [116, 44, 100]], // + deep heraldic purple
  pink:      [[236, 72, 153], [219, 39, 119], [251, 113, 133]],
  gray:      [[156, 163, 175], [107, 114, 128], [209, 213, 219]],
};

// Anything farther than this Lab ΔE from every reference is "unmappable"
// and gets surfaced as a candidate for future palette expansion. Lab ΔE
// 30 is roughly "definitely a different color family"; we use that as the
// cutoff so we only flag genuinely-novel colors, not borderline variants.
const UNMAPPABLE_DELTA_E = 30;

// ---- color parsing ----

// Named-color subset commonly found in flag SVGs. The full CSS-named list
// is hundreds of entries; we cover the dozen or so that Wikipedia/Commons
// flag templates actually use.
const NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  gold: [255, 215, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  brown: [165, 42, 42],
  navy: [0, 0, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  teal: [0, 128, 128],
  lime: [0, 255, 0],
  aqua: [0, 255, 255],
  fuchsia: [255, 0, 255],
};

// Parse a CSS color string into [r,g,b]. Returns null on patterns we don't
// handle (gradients, url(#...), currentColor, etc).
function parseColor(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (t === "none" || t === "transparent" || t === "currentcolor") return null;
  if (t.startsWith("url(")) return null;
  if (t in NAMED_COLORS) return NAMED_COLORS[t];
  // #RGB / #RRGGBB (with or without #)
  let m = t.match(/^#?([0-9a-f]{3})$/);
  if (m) {
    const [a, b, c] = m[1];
    return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)];
  }
  m = t.match(/^#?([0-9a-f]{6})$/);
  if (m) {
    return [
      parseInt(m[1].slice(0, 2), 16),
      parseInt(m[1].slice(2, 4), 16),
      parseInt(m[1].slice(4, 6), 16),
    ];
  }
  // rgb(R,G,B) or rgb(R G B) — also rgba, we drop alpha
  m = t.match(/^rgba?\s*\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) {
    return [
      Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      Math.max(0, Math.min(255, Math.round(Number(m[3])))),
    ];
  }
  return null;
}

// Walk an SVG text blob, harvesting every paint-like attribute or style.
// Returns Set<"r,g,b"> of distinct RGB triples seen. Yes, we will pick up
// stroke colors that might only outline a 1px shape — accepted tradeoff
// for the simplicity of not parsing the SVG DOM.
function extractColors(svgText) {
  const found = new Set();
  // fill="..." or stroke="..."
  for (const m of svgText.matchAll(/(?:fill|stroke)\s*=\s*"([^"]+)"/g)) {
    const c = parseColor(m[1]);
    if (c) found.add(c.join(","));
  }
  // style="...fill: foo; stroke: bar;..."  (both inline style= and <style> blocks)
  for (const m of svgText.matchAll(/(?:fill|stroke)\s*:\s*([^;"}\s]+)/g)) {
    const c = parseColor(m[1]);
    if (c) found.add(c.join(","));
  }
  return [...found].map((s) => s.split(",").map(Number));
}

// ---- color distance ----
//
// Convert sRGB -> linear -> XYZ -> Lab so we can compute perceptually-
// meaningful ΔE distances. Standard D65 illuminant. No need for ΔE2000 —
// CIE76 (Euclidean Lab) is good enough at the bucket sizes we work with.

function srgbToLinear(c) {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function rgbToLab([r, g, b]) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  // D65
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / 1.00000;
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE([l1, a1, b1], [l2, a2, b2]) {
  const dl = l1 - l2, da = a1 - a2, db = b1 - b2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

// Precompute Lab for every reference color. Each slug gets [Lab, Lab, ...].
const PALETTE_LAB = Object.fromEntries(
  Object.entries(PALETTE_REFS).map(([slug, refs]) => [slug, refs.map(rgbToLab)]),
);

// Returns { slug, dE } or { slug: null, dE, rgb } if no reference is close
// enough. The "close enough" cutoff is UNMAPPABLE_DELTA_E.
function nearestBucket(rgb) {
  const lab = rgbToLab(rgb);
  let best = { slug: null, dE: Infinity };
  for (const [slug, labRefs] of Object.entries(PALETTE_LAB)) {
    for (const ref of labRefs) {
      const dE = deltaE(lab, ref);
      if (dE < best.dE) best = { slug, dE };
    }
  }
  if (best.dE > UNMAPPABLE_DELTA_E) return { slug: null, dE: best.dE, rgb };
  return best;
}

// ---- SVG fetching ----

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Commons rejects bursts; mirror the ~2.5 req/s the thumbnail downloader
// uses. Only throttle on actual network fetches, not cache hits.
const FETCH_DELAY_MS = 400;
const FETCH_MAX_RETRIES = 4;
let lastFetchAt = 0;

async function throttle() {
  const wait = FETCH_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

async function fetchSvg(file, qid) {
  await mkdir(CACHE_DIR, { recursive: true });
  const dest = join(CACHE_DIR, `${qid}.svg`);
  if (!FORCE && (await fileExists(dest))) {
    return readFile(dest, "utf8");
  }
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
  // Retry with exponential backoff on 429/5xx, honoring Retry-After.
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "image/svg+xml" },
      redirect: "follow",
    });
    if (res.ok) {
      const text = await res.text();
      const tmp = dest + ".tmp";
      await writeFile(tmp, text);
      await rename(tmp, dest);
      return text;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < FETCH_MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 30_000)
        : Math.min(2_000 * 2 ** attempt, 30_000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
}

// ---- main ----

async function main() {
  const flagsPath = join(DATA_DIR, "flags.json");
  const overridesPath = join(DATA_DIR, "overrides.json");
  const data = JSON.parse(await readFile(flagsPath, "utf8"));
  const overrides = JSON.parse(await readFile(overridesPath, "utf8").catch(() => "{}"));

  let targets = data.flags.filter((f) => f.file?.toLowerCase().endsWith(".svg"));
  if (ONLY) targets = targets.filter((f) => ONLY.has(f.qid));
  console.log(`Targeting ${targets.length} SVG flag${targets.length === 1 ? "" : "s"}.`);
  if (targets.length === 0) return;

  // Aggregate "unmappable" colors so the next palette expansion has data.
  const unmappable = new Map(); // "r,g,b" -> { count, examples: [{qid, dE}] }

  let svgChanged = 0, colorsPromoted = 0, errors = 0, gradientCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    process.stdout.write(`  [${i + 1}/${targets.length}] ${f.qid} ${f.file.slice(0, 50).padEnd(50)} `);
    let svgText;
    try {
      svgText = await fetchSvg(f.file, f.qid);
    } catch (e) {
      process.stdout.write(`FETCH FAIL: ${e.message}\n`);
      errors++;
      continue;
    }
    // Note: not throttling — SVG fetches come from cache after the first run,
    // and Commons Special:FilePath has redirects that get cached too.
    // If you see HTTP 429 on first run, add a setTimeout(400) here.

    if (/<(?:linearGradient|radialGradient|pattern)\b/i.test(svgText)) {
      gradientCount++;
    }

    const rgbs = extractColors(svgText);
    const bucketed = new Set();
    for (const rgb of rgbs) {
      const r = nearestBucket(rgb);
      if (r.slug) {
        bucketed.add(r.slug);
      } else {
        const key = rgb.join(",");
        const u = unmappable.get(key) ?? { count: 0, examples: [] };
        u.count++;
        if (u.examples.length < 3) u.examples.push({ qid: f.qid, dE: Math.round(r.dE) });
        unmappable.set(key, u);
      }
    }
    const svgColors = [...bucketed].sort();
    process.stdout.write(`-> ${svgColors.join(", ") || "(none)"}`);

    const prevSvg = JSON.stringify(f.svgColors ?? null);
    const nextSvg = JSON.stringify(svgColors);
    if (prevSvg !== nextSvg) {
      svgChanged++;
      if (!DRY) f.svgColors = svgColors;
    }

    // Promote svgColors -> colors when the curator hasn't set a colors
    // override. The override is the curator's deliberate truth and must win;
    // for everything else, SVG extraction is more reliable than Wikidata's
    // sparse P462 coverage. We UNION with wdColors so anything Wikidata had
    // and SVG missed (rare) still survives.
    const hasColorOverride = "colors" in (overrides[f.qid] ?? {});
    if (!hasColorOverride && svgColors.length > 0) {
      const union = [...new Set([...(f.wdColors ?? []), ...svgColors])].sort();
      const prevColors = JSON.stringify(f.colors ?? []);
      const nextColors = JSON.stringify(union);
      if (prevColors !== nextColors) {
        colorsPromoted++;
        if (!DRY) f.colors = union;
        process.stdout.write(` | colors: ${union.join(", ")}`);
      }
    }
    process.stdout.write("\n");
  }

  console.log();
  console.log(`svgColors updated:    ${svgChanged} records.`);
  console.log(`colors promoted:      ${colorsPromoted} records (no curator override; union of wd+svg).`);
  console.log(`Errors:               ${errors}.`);
  if (gradientCount) console.log(`Flags with gradients/patterns (may miss colors): ${gradientCount}.`);

  if (unmappable.size > 0) {
    console.log(`\nUnmappable colors (${unmappable.size} distinct), top 20 by frequency:`);
    const top = [...unmappable.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20);
    for (const [rgb, { count, examples }] of top) {
      const [r, g, b] = rgb.split(",").map(Number);
      const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
      console.log(`  ${hex.padEnd(8)} count=${String(count).padStart(4)}  examples=${examples.map((e) => `${e.qid}(ΔE=${e.dE})`).join(", ")}`);
    }
  }

  if (DRY) {
    console.log("\n--dry: no write.");
    return;
  }
  const tmp = flagsPath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, flagsPath);
  console.log(`\nWrote ${flagsPath}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
