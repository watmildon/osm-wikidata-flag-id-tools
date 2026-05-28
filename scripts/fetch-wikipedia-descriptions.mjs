#!/usr/bin/env node
// One-shot enrichment: for the top N flags that lack a description, fetch
// the lead-paragraph extract from the linked English Wikipedia article.
// Writes results into data/overrides.json so the regular build pipeline
// picks them up.
//
// Usage:
//   node scripts/fetch-wikipedia-descriptions.mjs           # top 400
//   node scripts/fetch-wikipedia-descriptions.mjs --n 100   # top 100
//   node scripts/fetch-wikipedia-descriptions.mjs --dry     # don't write; just print
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/; fetch-wikipedia-descriptions.mjs)";

const argv = process.argv.slice(2);
const N = (() => {
  const i = argv.indexOf("--n");
  if (i >= 0) return Math.max(1, Number(argv[i + 1]) || 400);
  return 400;
})();
const DRY = argv.includes("--dry");

async function fetchJson(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ----- step 1: select target QIDs -----

async function selectTargets() {
  const flags = JSON.parse(
    await readFile(join(DATA_DIR, "flags.json"), "utf8")
  ).flags;
  // flags.json is already sorted by count desc.
  const targets = [];
  for (const f of flags) {
    if (targets.length >= N) break;
    if (!f.description) targets.push(f.qid);
  }
  console.log(`Selected ${targets.length} flags missing a description.`);
  return targets;
}

// ----- step 2: QID -> English Wikipedia title via SPARQL -----

async function mapToWikipediaTitles(qids) {
  const BATCH = 200;
  const map = new Map();
  for (let i = 0; i < qids.length; i += BATCH) {
    const slice = qids.slice(i, i + BATCH);
    const values = slice.map((q) => `wd:${q}`).join(" ");
    // schema:about ties a Wikipedia article URL to a Wikidata entity.
    const query = `
SELECT ?item ?article WHERE {
  VALUES ?item { ${values} }
  ?article schema:about ?item ;
           schema:inLanguage "en" ;
           schema:isPartOf <https://en.wikipedia.org/> .
}`;
    process.stdout.write(`  SPARQL ${i / BATCH + 1}/${Math.ceil(qids.length / BATCH)}... `);
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ query }).toString(),
    });
    if (!res.ok) {
      console.log(`FAIL ${res.status}`);
      continue;
    }
    const json = await res.json();
    let n = 0;
    for (const row of json.results.bindings) {
      const qid = row.item.value.split("/").pop();
      // Article URL is like https://en.wikipedia.org/wiki/Flag_of_Canada
      // We want the title path (decoded, with underscores -> spaces).
      const url = row.article.value;
      const title = decodeURIComponent(url.split("/wiki/").pop()).replace(/_/g, " ");
      map.set(qid, title);
      n++;
    }
    console.log(`${n} bindings`);
  }
  return map;
}

// ----- step 3: Wikipedia extracts -----

// Strip Wikipedia disambiguation/footnote noise that sometimes appears even in
// plaintext extracts. Trim to first 2 paragraphs to keep things tight.
function tidyExtract(text) {
  if (!text) return null;
  // Wikipedia plaintext extracts sometimes preserve unicode bullets or
  // section markers. Strip line-leading nothing-but-symbols runs.
  let s = text.replace(/^\s+|\s+$/g, "");
  // Take first two paragraphs.
  const paras = s.split(/\n+/).filter(Boolean).slice(0, 2);
  return paras.join("\n\n").trim();
}

async function fetchExtracts(titlesByQid) {
  // Group QIDs by title batches of ~20 (Wikipedia API caps at 20 titles per
  // call with explaintext=true). Use the same call to fetch all.
  const BATCH = 20;
  const qidsWithTitle = [...titlesByQid.entries()];
  const out = new Map();
  let done = 0;
  for (let i = 0; i < qidsWithTitle.length; i += BATCH) {
    const slice = qidsWithTitle.slice(i, i + BATCH);
    const titles = slice.map(([_, t]) => t).join("|");
    const url =
      "https://en.wikipedia.org/w/api.php" +
      "?action=query&prop=extracts&exintro=1&explaintext=1" +
      "&redirects=1&format=json" +
      `&titles=${encodeURIComponent(titles)}`;
    process.stdout.write(`  extracts ${i / BATCH + 1}/${Math.ceil(qidsWithTitle.length / BATCH)} (${slice.length} titles)... `);
    let json;
    try {
      json = await fetchJson(url, `wiki extracts batch ${i / BATCH + 1}`);
    } catch (e) {
      console.log(`FAIL ${e.message}`);
      continue;
    }
    // Build a map from normalized title -> page extract.
    const pages = json.query?.pages ?? {};
    const extractByTitle = new Map();
    for (const pageId in pages) {
      const p = pages[pageId];
      if (p.extract) extractByTitle.set(p.title, p.extract);
    }
    // Wikipedia may return redirected titles. Use the API's "redirects" + "normalized" maps.
    const redirects = json.query?.redirects ?? [];
    const normalized = json.query?.normalized ?? [];
    function resolveTitle(originalTitle) {
      let t = originalTitle;
      for (const n of normalized) if (n.from === t) t = n.to;
      for (const r of redirects) if (r.from === t) t = r.to;
      return t;
    }
    let n = 0;
    for (const [qid, title] of slice) {
      const resolved = resolveTitle(title);
      const ex = extractByTitle.get(resolved);
      if (ex) {
        out.set(qid, tidyExtract(ex));
        n++;
      }
    }
    done += slice.length;
    console.log(`${n}/${slice.length} extracts`);
    // Be polite — Wikipedia welcomes API use but asks for reasonable pacing.
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

// ----- step 4: persist -----

async function persist(extractsByQid) {
  const overridesPath = join(DATA_DIR, "overrides.json");
  const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
  let added = 0;
  for (const [qid, desc] of extractsByQid) {
    if (!overrides[qid]) overrides[qid] = {};
    if (!overrides[qid].description) {
      overrides[qid].description = desc;
      added++;
    }
  }
  const sorted = {};
  for (const k of Object.keys(overrides).sort()) sorted[k] = overrides[k];
  if (DRY) {
    console.log("(dry run, not writing)");
    return added;
  }
  await writeFile(overridesPath, JSON.stringify(sorted, null, 2) + "\n");

  // Also patch live flags.json so the new descriptions appear without a full
  // rebuild.
  const flagsPath = join(DATA_DIR, "flags.json");
  const flags = JSON.parse(await readFile(flagsPath, "utf8"));
  let patched = 0;
  for (const f of flags.flags) {
    if (extractsByQid.has(f.qid) && !f.description) {
      f.description = extractsByQid.get(f.qid);
      patched++;
    }
  }
  await writeFile(flagsPath, JSON.stringify(flags, null, 2) + "\n");
  console.log(`Wrote ${added} new descriptions to overrides.json; patched ${patched} live records.`);
  return added;
}

// ----- main -----

async function main() {
  const qids = await selectTargets();

  console.log("Mapping QIDs to English Wikipedia titles...");
  const titles = await mapToWikipediaTitles(qids);
  console.log(`Got titles for ${titles.size}/${qids.length} QIDs.`);

  if (titles.size === 0) {
    console.log("No Wikipedia articles found. Nothing to do.");
    return;
  }

  console.log("Fetching Wikipedia extracts...");
  const extracts = await fetchExtracts(titles);
  console.log(`Got extracts for ${extracts.size}/${titles.size} titled QIDs.`);

  // Print a representative sample for sanity.
  console.log("\nSample (first 5):");
  let n = 0;
  for (const [qid, desc] of extracts) {
    if (n++ >= 5) break;
    console.log(`  ${qid}: ${desc.slice(0, 200).replace(/\n/g, " ")}${desc.length > 200 ? "…" : ""}`);
  }

  const added = await persist(extracts);
  console.log(`\nDone. Added ${added} descriptions. ${qids.length - added} flags in target set still without one.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
