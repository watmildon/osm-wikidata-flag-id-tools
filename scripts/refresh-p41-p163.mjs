// Find subjects in flags.json that have a P41 (image of flag) statement on
// Wikidata but no P163 (flag) statement — i.e., the org has an image of its
// flag but no dedicated "flag of X" entity. These are Wikidata cleanup
// candidates: someone needs to create the flag entity (or find an existing
// one) and add the P163 link.
//
// Writes data/missing-flag-entities-auto.json — a parallel to the curated
// data/missing-flag-entities.json. The wikidata-suggestions page unions both.
//
// Usage:
//   node scripts/refresh-p41-p163.mjs        # write the file
//   node scripts/refresh-p41-p163.mjs --dry  # report changes, don't write

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const FLAGS_PATH = join(DATA_DIR, "flags.json");
const OUT_PATH = join(DATA_DIR, "missing-flag-entities-auto.json");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; refresh-p41-p163.mjs)";
const DRY = process.argv.includes("--dry");

// Fetch P41 and P163 in one query so we can identify subjects with P41 but no
// P163. Items missing both don't appear in results at all.
const SPARQL = `
SELECT ?item
       (GROUP_CONCAT(DISTINCT ?p41Image; SEPARATOR=",") AS ?p41Images)
       (COUNT(DISTINCT ?p163Flag) AS ?p163Count)
WHERE {
  VALUES ?item { __VALUES__ }
  { ?item wdt:P41 ?p41Image . }
  UNION
  { ?item wdt:P163 ?p163Flag . }
}
GROUP BY ?item
`;

async function probeBatch(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = SPARQL.replace("__VALUES__", values);
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

function qidSortKey(qid) { return Number(qid.slice(1)) || 0; }

async function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, path);
}

async function main() {
  const flagsJson = JSON.parse(await readFile(FLAGS_PATH, "utf8"));
  const flags = flagsJson.flags;
  // Candidates: anything we currently carry where the subject isn't already
  // classified as a flag entity. Include count==0 (seeded) entries too; if
  // Wikidata has a P41 we want to know regardless of OSM usage.
  const candidates = flags.filter((f) => !f.isFlagEntity);
  const byQid = new Map(candidates.map((f) => [f.qid, f]));
  console.log(`Probing ${candidates.length} non-flag-entity records...`);

  const BATCH = 500;
  const entries = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH).map((f) => f.qid);
    process.stdout.write(`  batch ${i / BATCH + 1}/${Math.ceil(candidates.length / BATCH)} (${slice.length} QIDs)... `);
    let rows;
    try {
      rows = await probeBatch(slice);
    } catch (e) {
      process.stdout.write(`FAIL: ${e.message}\n`);
      throw e;
    }
    process.stdout.write(`${rows.length} rows\n`);
    for (const row of rows) {
      const qid = row.item.value.split("/").pop();
      const cand = byQid.get(qid);
      if (!cand) continue;
      const p41Raw = row.p41Images?.value ?? "";
      const p163Count = Number(row.p163Count?.value ?? "0");
      if (!p41Raw || p163Count > 0) continue; // only want P41-without-P163
      const p41Files = p41Raw
        .split(",")
        .filter(Boolean)
        .map((u) => decodeURIComponent(u.split("Special:FilePath/").pop() ?? u));
      entries.push({
        subject_qid: qid,
        subject_name: cand.name,
        count: cand.count,
        p41_files: p41Files,
        source: "auto",
      });
    }
  }

  entries.sort((a, b) => qidSortKey(a.subject_qid) - qidSortKey(b.subject_qid));
  console.log(`\nFound ${entries.length} subjects with P41 but no P163.`);

  // Compare against existing file so a no-op run prints a clear summary.
  let previous = [];
  try {
    const prev = JSON.parse(await readFile(OUT_PATH, "utf8"));
    previous = prev.entries ?? [];
  } catch { /* first run */ }
  const prevQids = new Set(previous.map((e) => e.subject_qid));
  const curQids = new Set(entries.map((e) => e.subject_qid));
  const added = [...curQids].filter((q) => !prevQids.has(q));
  const removed = [...prevQids].filter((q) => !curQids.has(q));
  console.log(`  added since last run:   ${added.length}`);
  console.log(`  removed since last run: ${removed.length}`);

  if (DRY) {
    console.log("\n--dry: no file written.");
    if (added.length || removed.length) {
      console.log("Top 10 added:");
      for (const q of added.slice(0, 10)) {
        const e = entries.find((x) => x.subject_qid === q);
        console.log(`  ${q.padEnd(10)} count=${String(e.count).padStart(4)}  ${e.subject_name}`);
      }
    }
    return;
  }

  await writeJsonAtomic(OUT_PATH, {
    _comment:
      "Auto-generated by scripts/refresh-p41-p163.mjs. Subjects in flags.json " +
      "whose Wikidata entity has a P41 (image of flag) statement but no P163 " +
      "(flag) statement — i.e., a flag image exists but no dedicated 'flag of X' " +
      "entity has been created. Re-run the script to refresh; the wikidata-" +
      "suggestions page reads this alongside the hand-curated " +
      "missing-flag-entities.json. Sorted by QID numerically.",
    entries,
  });
  console.log(`Wrote ${OUT_PATH}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
