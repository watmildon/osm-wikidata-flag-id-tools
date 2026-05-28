#!/usr/bin/env node
// Re-merge the Name Suggestion Index flagpole bundle into data/flags.json.
//
// NSI (iD editor's hand-curated bundle) provides flag:name, flag:type, plus
// extra subject / subject:wikidata / country tags. We don't pull this on
// every build any more — we're the source of truth — so this script is the
// way to refresh those fields when NSI updates upstream.
//
// Source: https://github.com/osmlab/name-suggestion-index (BSD-3-Clause).
//
// Usage:
//   node scripts/refresh-nsi.mjs           # update flags.json in place
//   node scripts/refresh-nsi.mjs --dry     # report what would change, don't write
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const CACHE_DIR = join(ROOT, "data", ".cache");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; refresh-nsi.mjs)";
const NSI_URL =
  "https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/data/flags/man_made/flagpole.json";

const DRY = process.argv.includes("--dry");

async function fetchNsi() {
  console.log("Fetching NSI flagpole bundle...");
  try {
    const res = await fetch(NSI_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = join(CACHE_DIR, "nsi-flagpole.json.tmp");
    await writeFile(tmp, JSON.stringify(json, null, 2) + "\n");
    await rename(tmp, join(CACHE_DIR, "nsi-flagpole.json"));
    return { json, source: "fresh" };
  } catch (e) {
    console.log(`  upstream failed: ${e.message}`);
    try {
      const cached = JSON.parse(await readFile(join(CACHE_DIR, "nsi-flagpole.json"), "utf8"));
      console.log("  falling back to cached NSI bundle");
      return { json: cached, source: "cache" };
    } catch {
      throw new Error("No NSI data available (upstream down, no cache)");
    }
  }
}

async function main() {
  const flagsPath = join(DATA_DIR, "flags.json");
  const data = JSON.parse(await readFile(flagsPath, "utf8"));

  const { json: nsi, source } = await fetchNsi();
  const byQid = new Map();
  for (const item of nsi.items ?? []) {
    const qid = item.tags?.["flag:wikidata"];
    if (qid) byQid.set(qid, item);
  }
  console.log(`NSI: ${byQid.size} flag entries${source === "cache" ? " (cached)" : ""}.`);

  let changed = 0;
  for (const f of data.flags) {
    const item = byQid.get(f.qid);
    if (!item) continue;
    const t = item.tags ?? {};
    const next = { ...f };
    const extras = {};
    if (t["subject"])          extras["subject"] = t["subject"];
    if (t["subject:wikidata"]) extras["subject:wikidata"] = t["subject:wikidata"];
    if (t["country"])          extras["country"] = t["country"];
    if (t["flag:name"]) next.flagName = t["flag:name"];
    if (t["flag:type"]) next.flagType = t["flag:type"];
    next.extraTags = extras;
    if (JSON.stringify(next) !== JSON.stringify(f)) {
      changed++;
      if (!DRY) Object.assign(f, next);
    }
  }
  console.log(`${changed} flag records updated by NSI merge.`);

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
