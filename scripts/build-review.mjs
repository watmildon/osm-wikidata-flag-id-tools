#!/usr/bin/env node
// Standalone: build data/review.json from data/non-flag-qids.json (or
// data/flags.json fallback) without re-running the full pipeline. Useful for
// iterating on the review query against existing build output.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; build-review.mjs)";

// See build-flags.mjs for the reasoning: P31/P279* and P18 are intentionally
// OPTIONAL so we surface stub P163 targets too. target_is_stub marks them.
const QUERY = `
SELECT ?item ?itemLabel ?flag ?flagLabel ?isFlagEntity ?image WHERE {
  VALUES ?item { __VALUES__ }
  ?item wdt:P163 ?flag .
  OPTIONAL {
    { ?flag wdt:P31/wdt:P279* wd:Q69506823 } UNION
    { ?flag wdt:P31/wdt:P279* wd:Q14660    }
    BIND(true AS ?isFlagEntity)
  }
  OPTIONAL { ?flag wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

async function batch(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = QUERY.replace("__VALUES__", values);
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

async function main() {
  // Load non-flag QIDs as the candidate set.
  const nf = JSON.parse(
    await readFile(join(DATA_DIR, "non-flag-qids.json"), "utf8")
  );
  const candByQid = new Map(nf.map((r) => [r.qid, r]));
  console.log(`${nf.length} non-flag QIDs to inspect.`);

  const BATCH = 500;
  const suggestions = [];
  const qids = [...candByQid.keys()];
  for (let i = 0; i < qids.length; i += BATCH) {
    const slice = qids.slice(i, i + BATCH);
    console.log(`  batch ${i / BATCH + 1}/${Math.ceil(qids.length / BATCH)} (${slice.length} QIDs)...`);
    const rows = await batch(slice);
    for (const row of rows) {
      const itemQid = row.item.value.split("/").pop();
      const cand = candByQid.get(itemQid);
      if (!cand) continue;
      const flagQid = row.flag.value.split("/").pop();
      if (flagQid === itemQid) continue;
      const isFlagEntity = row.isFlagEntity?.value === "true";
      const hasImage = Boolean(row.image?.value);
      const suggestion = {
        bad_qid: itemQid,
        bad_name: cand.name,
        count: cand.count,
        suggested_qid: flagQid,
        suggested_name: row.flagLabel?.value ?? flagQid,
      };
      if (!isFlagEntity || !hasImage) {
        suggestion.target_is_stub = true;
      }
      suggestions.push(suggestion);
    }
  }

  // Dedupe; sort by QID for canonical on-disk order (the review page re-sorts
  // by count at runtime).
  const seen = new Set();
  const unique = [];
  for (const s of suggestions) {
    if (seen.has(s.bad_qid)) continue;
    seen.add(s.bad_qid);
    unique.push(s);
  }
  unique.sort((a, b) => Number(a.bad_qid.slice(1)) - Number(b.bad_qid.slice(1)));

  await writeFile(
    join(DATA_DIR, "review.json"),
    JSON.stringify({ generated: new Date().toISOString(), suggestions: unique }, null, 2) + "\n"
  );
  console.log(`Wrote data/review.json (${unique.length} suggested fixes).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
