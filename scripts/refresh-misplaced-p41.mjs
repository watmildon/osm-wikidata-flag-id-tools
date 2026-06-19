#!/usr/bin/env node
// Find flag entities that have an image on Wikidata's P41 ("image of
// flag") property instead of P18 ("image"). P41 belongs on a subject
// entity (a city, organisation, etc.) pointing at its flag's image; it
// is not meant to be set on the flag entity itself. When editors set it
// here by mistake, mainstream Wikidata consumers (including this site,
// pre-fallback) miss the image.
//
// We surface these as a wikidata-cleanup task: the editor moves the
// value from P41 to P18 on the flag entity. Our build falls back to
// P41 so the flag still shows up while the cleanup is pending — the
// `wdImageProperty` field on each flags.json record records which
// property the value came from.
//
// Source: data/flags.json. Output: data/misplaced-p41.json with one
// entry per affected QID, including the Commons filename.
//
// Usage:
//   npm run refresh:p41-on-flag        # write data/misplaced-p41.json
//   npm run refresh:p41-on-flag --dry  # preview without writing

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const FLAGS_PATH = join(DATA_DIR, "flags.json");
const OUT_PATH = join(DATA_DIR, "misplaced-p41.json");

const DRY = process.argv.includes("--dry");

const flagsJson = JSON.parse(await readFile(FLAGS_PATH, "utf8"));
const candidates = flagsJson.flags
  .filter((f) => f.isFlagEntity && f.file && f.wdImageProperty === "P41")
  .map((f) => ({
    qid: f.qid,
    name: f.name,
    count: f.count ?? 0,
    file: f.file,
  }))
  // Sort by OSM count desc so the highest-impact entries bubble up.
  .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

console.log(`Flag entities with image on P41 (should be P18): ${candidates.length}`);
for (const c of candidates.slice(0, 20)) {
  console.log(`  ${c.qid.padEnd(11)} count=${String(c.count).padStart(4)}  ${c.name}`);
  console.log(`    file: ${c.file}`);
}

if (DRY) {
  console.log("\n--dry: not writing data/misplaced-p41.json.");
  process.exit(0);
}

const out = {
  generated: new Date().toISOString(),
  note: "Flag entities whose Commons image was set on Wikidata's P41 (image of flag) instead of P18 (image). P41 belongs on the subject entity pointing at its flag's image; flag entities themselves should use P18. Fix by moving the value from P41 to P18 on the flag entity. Our build falls back to P41 so the flag still renders in the meantime; wdImageProperty in flags.json records the source.",
  candidates,
};

const tmp = OUT_PATH + ".tmp";
await writeFile(tmp, JSON.stringify(out, null, 2) + "\n");
await rename(tmp, OUT_PATH);
console.log(`\nWrote ${OUT_PATH} (${candidates.length} candidates).`);
