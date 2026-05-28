#!/usr/bin/env node
// Re-infer flag:type and flag:name from OSM mapper consensus via Overpass.
//
// For each QID with >= MIN_SAMPLE OSM uses, fetch all single-value usages and
// pick the dominant flag:type / flag:name if a clear winner exists
// (>= DOMINANCE share). Updates data/flags.json in place.
//
// We don't run this on every build any more — we're the source of truth — so
// invoke this script when you want to pick up newly-tagged mapper consensus.
//
// Usage:
//   node scripts/refresh-overpass.mjs              # update all eligible QIDs
//   node scripts/refresh-overpass.mjs --dry        # report changes, don't write
//   node scripts/refresh-overpass.mjs --only=Q42537,Q142 # restrict to specific QIDs
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; refresh-overpass.mjs)";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const MIN_SAMPLE = 5;
const DOMINANCE = 0.7;
const BATCH = 20;

const DRY = process.argv.includes("--dry");
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
})();

function buildQuery(qids) {
  const lines = qids.map((q) => `  nwr["flag:wikidata"="${q}"];`).join("\n");
  return `[out:json][timeout:120];\n(\n${lines}\n);\nout tags;`;
}

async function overpassBatch(qids) {
  const query = buildQuery(qids);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const byQid = new Map();
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const wd = tags["flag:wikidata"];
    if (!wd || !qids.includes(wd)) continue;
    if (!byQid.has(wd)) byQid.set(wd, { total: 0, types: new Map(), names: new Map() });
    const bucket = byQid.get(wd);
    bucket.total++;
    if (tags["flag:type"]) bucket.types.set(tags["flag:type"], (bucket.types.get(tags["flag:type"]) ?? 0) + 1);
    if (tags["flag:name"]) bucket.names.set(tags["flag:name"], (bucket.names.get(tags["flag:name"]) ?? 0) + 1);
  }
  return byQid;
}

function pickDominant(counts, total) {
  if (!total || total < MIN_SAMPLE) return null;
  let top = null, topN = 0;
  for (const [val, n] of counts) {
    if (n > topN) { top = val; topN = n; }
  }
  if (!top) return null;
  return (topN / total) >= DOMINANCE ? top : null;
}

async function main() {
  const flagsPath = join(DATA_DIR, "flags.json");
  const data = JSON.parse(await readFile(flagsPath, "utf8"));

  let eligible = data.flags.filter((f) => f.count >= MIN_SAMPLE);
  if (ONLY) eligible = eligible.filter((f) => ONLY.has(f.qid));
  console.log(`Overpass: ${eligible.length} eligible QID${eligible.length === 1 ? "" : "s"} (count >= ${MIN_SAMPLE}${ONLY ? `, --only filter` : ""}).`);

  let typeChanged = 0, nameChanged = 0;
  for (let i = 0; i < eligible.length; i += BATCH) {
    const slice = eligible.slice(i, i + BATCH);
    const qids = slice.map((f) => f.qid);
    process.stdout.write(`  batch ${i / BATCH + 1}/${Math.ceil(eligible.length / BATCH)}... `);
    let byQid;
    try {
      byQid = await overpassBatch(qids);
    } catch (e) {
      process.stdout.write(`FAIL: ${e.message}\n`);
      continue;
    }
    for (const f of slice) {
      const bucket = byQid.get(f.qid);
      if (!bucket) continue;
      const t = pickDominant(bucket.types, bucket.total);
      const n = pickDominant(bucket.names, bucket.total);
      if (t && t !== f.flagType) {
        typeChanged++;
        if (!DRY) { f.flagType = t; f.flagTypeSample = bucket.total; }
      }
      if (n && n !== f.flagName) {
        nameChanged++;
        if (!DRY) f.flagName = n;
      }
    }
    process.stdout.write(`ok\n`);
    // Overpass etiquette.
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`Changed: flag:type ${typeChanged}, flag:name ${nameChanged}.`);

  if (DRY) {
    console.log("--dry: no write.");
    return;
  }
  const tmp = flagsPath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, flagsPath);
  console.log(`Wrote ${flagsPath}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
