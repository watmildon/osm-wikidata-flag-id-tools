#!/usr/bin/env node
// Re-enrich existing flag records against current Wikidata state.
//
// The main build only enriches NEW QIDs (source-of-truth model). When a
// Wikidata editor adds a P18 image to an entity we already have, or fixes
// the isFlagEntity classification, or adds P462 colors, the change never
// reaches us. This script is the escape hatch.
//
// What gets re-pulled per QID:
//   - label (name)
//   - P18 image (-> file, then downloads 200px + 400px PNG to flags/{thumb,full})
//   - P462 colors
//   - isFlagEntity (P31/P279* of Q69506823 or Q14660)
//   - dimensions -> shape
//
// What is NOT touched:
//   - count (taginfo refresh runs in the main build)
//   - flagType / flagName / flagTypeSample (refresh-overpass / refresh-nsi own these)
//   - extraTags (refresh-nsi owns these)
//   - aliases (redirect map owns these)
//   - description / icons (curator-owned)
//   - any field present in data/overrides.json (re-merged after refresh)
//
// Usage:
//   node scripts/refresh-wikidata.mjs --missing-images           # only records where file===null
//   node scripts/refresh-wikidata.mjs --only=Q123,Q456           # specific QIDs
//   node scripts/refresh-wikidata.mjs --not-flag-entity          # records where isFlagEntity===false
//   node scripts/refresh-wikidata.mjs --all                      # every record (nuclear option)
//   node scripts/refresh-wikidata.mjs --missing-images --dry     # preview without writing
//
// Multiple selectors combine as a union. At least one selector is required.
import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const THUMB_DIR = join(ROOT, "flags", "thumb");
const FULL_DIR = join(ROOT, "flags", "full");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; refresh-wikidata.mjs)";

const DRY = process.argv.includes("--dry");
const MISSING_IMAGES = process.argv.includes("--missing-images");
const NOT_FLAG_ENTITY = process.argv.includes("--not-flag-entity");
const ALL = process.argv.includes("--all");
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
})();

// Mirror the build-flags.mjs color and image-scoring logic. Kept in sync by hand;
// these are stable enough that duplication beats a refactor that risks breaking
// the main build.
const COLOR_QID_MAP = {
  Q3142: "red", Q303826: "red",
  Q23444: "white",
  Q1088: "blue", Q5975887: "blue",
  Q1602687: "lightblue", Q373160: "lightblue", Q373058: "lightblue",
  Q3133: "green", Q864152: "green",
  Q943: "yellow", Q208045: "yellow",
  Q23445: "black",
  Q39338: "orange",
  Q47071: "brown",
  Q3257809: "purple", Q428124: "purple",
};

function imageScore(filename) {
  const name = filename.toLowerCase();
  const isSvg = name.endsWith(".svg");
  const isVariant = /construction|specification|sheet|diagram|drawing|template|measurements|grid|waving|wavy|photo|photograph|hoisted|raised|ceremony|3d|render/.test(name);
  let score = 0;
  if (isSvg) score += 100;
  if (!isVariant) score += 50;
  score -= name.length / 100;
  return score;
}

function pickBestImage(imagesStr) {
  if (!imagesStr) return null;
  const urls = imagesStr.split("").filter(Boolean);
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  const scored = urls.map((u) => {
    const file = decodeURIComponent(u.split("Special:FilePath/").pop());
    return { url: u, file, score: imageScore(file) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

const SPARQL_QUERY = `
SELECT ?item ?itemLabel ?isFlag
       (GROUP_CONCAT(DISTINCT ?image;   separator="\\u0001") AS ?images)
       (GROUP_CONCAT(DISTINCT ?colorQid; separator=",")      AS ?colorQids)
       (SAMPLE(?width)  AS ?w)
       (SAMPLE(?height) AS ?h)
WHERE {
  VALUES ?item { __VALUES__ }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    { ?item wdt:P31/wdt:P279* wd:Q69506823 } UNION
    { ?item wdt:P31/wdt:P279* wd:Q14660    }
    BIND(true AS ?isFlag)
  }
  OPTIONAL {
    ?item wdt:P462 ?color .
    BIND(STRAFTER(STR(?color), "http://www.wikidata.org/entity/") AS ?colorQid)
  }
  OPTIONAL { ?item wdt:P2049 ?width . }
  OPTIONAL { ?item wdt:P2048 ?height . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?item ?itemLabel ?isFlag
`;

async function enrichBatch(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = SPARQL_QUERY.replace("__VALUES__", values);
  const res = await fetch("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).results.bindings;
}

function rowToEnrichment(row) {
  const name = row?.itemLabel?.value ?? null;
  const image = pickBestImage(row?.images?.value);
  const file = image
    ? decodeURIComponent(image.split("Special:FilePath/").pop())
    : null;
  const isFlagEntity = row?.isFlag?.value === "true";
  const colorQids = (row?.colorQids?.value ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const wdColors = [...new Set(colorQids.map((q) => COLOR_QID_MAP[q]).filter(Boolean))];
  const width = row?.w ? Number(row.w.value) : null;
  const height = row?.h ? Number(row.h.value) : null;
  const shape = width && height && width === height ? "square" : "rectangle";
  return { name, file, isFlagEntity, wdColors, colors: wdColors, shape };
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function downloadThumb(file, qid, width, destDir) {
  const dest = join(destDir, `${qid}.png`);
  // Always re-download here — caller already decided this QID's image changed.
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  if (!MISSING_IMAGES && !NOT_FLAG_ENTITY && !ALL && !ONLY) {
    console.error("error: pick at least one selector (--missing-images / --not-flag-entity / --only=Q1,Q2 / --all).");
    process.exit(2);
  }

  const flagsPath = join(DATA_DIR, "flags.json");
  const data = JSON.parse(await readFile(flagsPath, "utf8"));
  const overrides = JSON.parse(await readFile(join(DATA_DIR, "overrides.json"), "utf8").catch(() => "{}"));

  // Build the target set as the union of all selectors.
  const targets = new Set();
  if (ALL) for (const f of data.flags) targets.add(f.qid);
  if (MISSING_IMAGES) for (const f of data.flags) if (!f.file) targets.add(f.qid);
  if (NOT_FLAG_ENTITY) for (const f of data.flags) if (!f.isFlagEntity) targets.add(f.qid);
  if (ONLY) for (const q of ONLY) targets.add(q);

  const byQid = new Map(data.flags.map((f) => [f.qid, f]));
  const targetQids = [...targets].filter((q) => byQid.has(q));
  const skippedUnknown = [...targets].filter((q) => !byQid.has(q));
  console.log(`Targeting ${targetQids.length} record${targetQids.length === 1 ? "" : "s"} for re-enrichment.`);
  if (skippedUnknown.length) {
    console.log(`  (skipping ${skippedUnknown.length} unknown QIDs not in flags.json: ${skippedUnknown.slice(0, 5).join(", ")}${skippedUnknown.length > 5 ? "..." : ""})`);
  }
  if (targetQids.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // SPARQL: 500 per batch, same as the main build.
  const BATCH = 500;
  const enrichment = new Map();
  for (let i = 0; i < targetQids.length; i += BATCH) {
    const slice = targetQids.slice(i, i + BATCH);
    process.stdout.write(`  SPARQL batch ${i / BATCH + 1}/${Math.ceil(targetQids.length / BATCH)} (${slice.length} QIDs)... `);
    try {
      const rows = await enrichBatch(slice);
      for (const row of rows) {
        const qid = row.item.value.split("/").pop();
        enrichment.set(qid, rowToEnrichment(row));
      }
      process.stdout.write(`ok\n`);
    } catch (e) {
      process.stdout.write(`FAIL: ${e.message}\n`);
    }
  }

  // Apply enrichment, respecting overrides (anything in overrides.json wins,
  // since the curator deliberately set it).
  // Track per-field deltas for the summary.
  let updated = 0, gainedImage = 0, lostImage = 0, gainedFlagEntity = 0;
  let newColors = 0, shapeFlipped = 0, nameChanged = 0;
  const imageChangedQids = [];

  for (const f of data.flags) {
    const e = enrichment.get(f.qid);
    if (!e) continue;
    const ov = overrides[f.qid] ?? {};
    const next = { ...f };

    if (!("name" in ov) && e.name && e.name !== f.name) {
      next.name = e.name; nameChanged++;
    }

    // Image: handle gain, change, and (rare) loss separately so we know which
    // thumbnails to download.
    if (!("file" in ov) && e.file !== f.file) {
      next.file = e.file;
      if (!f.file && e.file) { gainedImage++; imageChangedQids.push(f.qid); }
      else if (f.file && !e.file) lostImage++;
      else if (f.file && e.file) imageChangedQids.push(f.qid); // file swap
    }

    // wdColors mirrors Wikidata's current P462-derived palette and is NOT
    // gated by overrides — its job is to surface Wikidata's truth so the
    // suggestions page can diff against ours. `colors` is the user-facing
    // palette and continues to respect overrides.
    if (JSON.stringify(f.wdColors ?? []) !== JSON.stringify(e.wdColors)) {
      next.wdColors = e.wdColors;
    }
    if (!("colors" in ov)) {
      const prev = JSON.stringify(f.colors ?? []);
      const cur = JSON.stringify(e.colors);
      if (prev !== cur && e.colors.length > 0) {
        next.colors = e.colors; newColors++;
      }
    }

    if (!("isFlagEntity" in ov) && e.isFlagEntity && !f.isFlagEntity) {
      next.isFlagEntity = true; gainedFlagEntity++;
    }

    if (!("shape" in ov) && e.shape !== f.shape) {
      next.shape = e.shape; shapeFlipped++;
    }

    if (JSON.stringify(next) !== JSON.stringify(f)) {
      updated++;
      if (!DRY) Object.assign(f, next);
    }
  }

  console.log(`\nField-level changes across ${updated} record${updated === 1 ? "" : "s"}:`);
  console.log(`  name changed:              ${nameChanged}`);
  console.log(`  gained an image:           ${gainedImage}`);
  console.log(`  image swapped (had/has):   ${imageChangedQids.length - gainedImage}`);
  console.log(`  lost an image:             ${lostImage}`);
  console.log(`  newly pass isFlagEntity:   ${gainedFlagEntity}`);
  console.log(`  colors added/changed:      ${newColors}`);
  console.log(`  shape flipped:             ${shapeFlipped}`);

  if (DRY) {
    console.log("\n--dry: no flags.json write, no thumbnails downloaded.");
    return;
  }

  // Download new/changed thumbnails. Sequential at ~2.5 req/s, same as the
  // main build, to avoid HTTP 429 from Commons.
  if (imageChangedQids.length > 0) {
    await mkdir(THUMB_DIR, { recursive: true });
    await mkdir(FULL_DIR, { recursive: true });
    console.log(`\nDownloading thumbnails for ${imageChangedQids.length} changed image${imageChangedQids.length === 1 ? "" : "s"}...`);
    const failures = [];
    for (const qid of imageChangedQids) {
      const f = byQid.get(qid);
      if (!f.file) continue;
      for (const [w, dir] of [[200, THUMB_DIR], [400, FULL_DIR]]) {
        try {
          const bytes = await downloadThumb(f.file, qid, w, dir);
          process.stdout.write(`  ${qid} ${w}px ${(bytes / 1024).toFixed(1)} KB\n`);
        } catch (e) {
          failures.push({ qid, w, error: e.message });
          process.stdout.write(`  ${qid} ${w}px FAIL ${e.message}\n`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (failures.length) {
      console.log(`\n${failures.length} thumbnail failure${failures.length === 1 ? "" : "s"}.`);
    }
  }

  // Write atomically.
  const tmp = flagsPath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, flagsPath);
  console.log(`\nWrote ${flagsPath}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
