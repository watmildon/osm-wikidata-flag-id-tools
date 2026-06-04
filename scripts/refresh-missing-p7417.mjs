#!/usr/bin/env node
// Find flag entities that should have a reverse-side image (P7417) on
// Wikidata but don't. Generates data/missing-p7417.json for the
// wikidata-suggestions page.
//
// Source of truth for "known to have a reverse": data/known-reverses.json.
// Bootstrapped from
// https://en.wikipedia.org/wiki/List_of_flags_with_reverses_that_differ_from_the_obverse
// — add more by PR as you find them.
//
// For each candidate we:
//   1. Skip if not in our dataset (no point surfacing flags we don't carry).
//   2. Query Wikidata for current P7417 statements; skip if already set
//      (someone added it after we last refreshed).
//   3. Search Wikimedia Commons for "Flag of X reverse" to suggest a
//      candidate filename a Wikidata editor can paste into P7417.
//
// Usage:
//   npm run refresh:p7417           # refresh data/missing-p7417.json
//   npm run refresh:p7417 -- --dry  # preview without writing
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; refresh-missing-p7417.mjs)";

const DRY = process.argv.includes("--dry");

// Match Commons filenames that look like a reverse-side variant. Conservative
// on purpose — better to surface nothing than to suggest the wrong file.
const REVERSE_FILENAME_RE = /\b(reverse|verso|back[ _-]?side|envers|r[eé]verso)\b/i;
// For historical-flag rows we ALSO want the obverse (front) of the historical
// variant so an editor can create a brand-new Wikidata item for the historical
// flag with both images. A filename "passes" as a candidate obverse if it does
// NOT look like a reverse, does NOT look like a coat of arms / unrelated
// thing, and (if we have a period for the flag) mentions a year inside that
// period.
const COA_NOISE_RE = /coat[ _-]?of[ _-]?arms|escutcheon|seal[ _-]of|emblem of|construction[ _-]?sheet|specification|template|locator|map|flag-map|orthographic/i;
// Pause between Commons API calls to be polite. Commons doesn't 429 as
// aggressively as their thumbnail server, but we still keep it slow.
const COMMONS_DELAY_MS = 400;

// "1908–1971" / "1861-1865" / "1898–1901" — return [startYear, endYearOrNull].
function parsePeriod(period) {
  if (!period) return null;
  const m = period.match(/(\d{4})\s*[–-]\s*(\d{4}|present)/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = /present/i.test(m[2]) ? null : Number(m[2]);
  return { start, end };
}
// True if the filename's year-ish numbers overlap with [start,end].
// Conservative: returns true if no years appear in the filename (we can't
// rule it out), false only when every 4-digit year is outside the window.
function filenameInPeriod(filename, period) {
  const p = parsePeriod(period);
  if (!p) return true;
  const years = [...filename.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return true;
  const end = p.end ?? new Date().getFullYear();
  return years.some((y) => y >= p.start - 1 && y <= end + 1);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Wikidata: for each candidate QID, get P7417 (current reverse images) and
// label. Batched 100 per call to keep URLs short.
async function fetchWikidataState(qids) {
  const result = new Map();
  const BATCH = 100;
  for (let i = 0; i < qids.length; i += BATCH) {
    const slice = qids.slice(i, i + BATCH);
    const values = slice.map((q) => `wd:${q}`).join(" ");
    const query = `
SELECT ?item ?itemLabel
       (GROUP_CONCAT(DISTINCT ?reverse; separator="\\u0001") AS ?reverses)
WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P7417 ?reverse . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?item ?itemLabel
`;
    const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({
      query,
      format: "json",
    }).toString();
    const json = await fetchJson(url);
    for (const row of json.results.bindings) {
      const qid = row.item.value.split("/").pop();
      const reverses = (row.reverses?.value ?? "")
        .split("").filter(Boolean);
      result.set(qid, {
        label: row.itemLabel?.value ?? qid,
        hasReverse: reverses.length > 0,
      });
    }
  }
  return result;
}

// Run a Commons file search for one query, returning filenames (without
// the "File:" prefix). Returns [] on transient failure.
async function commonsSearch(query) {
  const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query",
    format: "json",
    list: "search",
    srnamespace: "6",
    srlimit: "20",
    srsearch: query,
  }).toString();
  try {
    const json = await fetchJson(url);
    return (json.query?.search ?? []).map((r) => r.title.replace(/^File:/, ""));
  } catch (e) {
    console.log(`    Commons search failed (${e.message}); skipping`);
    return [];
  }
}

// Sort filename candidates: SVG first, then shortest name (canonical
// version is usually shortest).
function rankFilenames(hits) {
  return [...hits].sort((a, b) => {
    const av = a.toLowerCase().endsWith(".svg") ? 0 : 1;
    const bv = b.toLowerCase().endsWith(".svg") ? 0 : 1;
    if (av !== bv) return av - bv;
    return a.length - b.length;
  });
}

// Search Commons for files matching "<name> reverse" and return up to N
// filenames that look like genuine reverse-side variants. When `period` is
// set, prefer files whose filename mentions a year inside that period — the
// historical-flag rows want the historical reverse, not the modern one.
async function searchCommonsReverse(name, period) {
  const subject = name.replace(/^flag of (the )?/i, "").trim();
  const queries = [
    `Flag of ${subject} reverse`,
    `${subject} reverse flag`,
  ];
  const seen = new Set();
  const hits = [];
  for (const q of queries) {
    for (const title of await commonsSearch(q)) {
      if (seen.has(title)) continue;
      if (!REVERSE_FILENAME_RE.test(title)) continue;
      if (!filenameInPeriod(title, period)) continue;
      seen.add(title);
      hits.push(title);
    }
    await new Promise((r) => setTimeout(r, COMMONS_DELAY_MS));
  }
  return rankFilenames(hits).slice(0, 3);
}

// For historical flags only: find candidate OBVERSE files for the
// historical period. An editor creating a brand-new Wikidata entity for
// the historical flag needs both sides ready. We require the filename to
// (a) not look like a reverse, (b) not look like an unrelated CoA / map /
// "Flag orb" / "flag heart" icon, (c) mention a year inside the period.
// Without (c) the modern flag's filename (e.g. "Flag of Massachusetts.svg")
// dominates the results, which defeats the purpose.
async function searchCommonsHistoricalObverse(name, period) {
  const subject = name.replace(/^flag of (the )?/i, "").trim();
  const p = parsePeriod(period);
  if (!p) return []; // can't filter to historical period without one
  // Bias the query toward years in the period so search ranking favors them.
  const queries = [
    `Flag of ${subject} ${p.start}`,
    p.end ? `Flag of ${subject} ${p.end}` : `Flag of ${subject} historical`,
    `Flag of ${subject}`,
  ];
  const seen = new Set();
  const hits = [];
  for (const q of queries) {
    for (const title of await commonsSearch(q)) {
      if (seen.has(title)) continue;
      if (REVERSE_FILENAME_RE.test(title)) continue;
      if (COA_NOISE_RE.test(title)) continue;
      // Stricter than reverse search: REQUIRE a year inside the period.
      // Filenames without any year are typically the modern flag baseline
      // ("Flag of Massachusetts.svg") and aren't what the editor wants when
      // creating a NEW item for the historical variant.
      const years = [...title.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
      if (years.length === 0) continue;
      const end = p.end ?? new Date().getFullYear();
      if (!years.some((y) => y >= p.start - 1 && y <= end + 1)) continue;
      seen.add(title);
      hits.push(title);
    }
    await new Promise((r) => setTimeout(r, COMMONS_DELAY_MS));
  }
  return rankFilenames(hits).slice(0, 3);
}

async function main() {
  const known = JSON.parse(await readFile(join(DATA_DIR, "known-reverses.json"), "utf8"));
  const flagsData = JSON.parse(await readFile(join(DATA_DIR, "flags.json"), "utf8"));
  const byQid = new Map(flagsData.flags.map((f) => [f.qid, f]));

  const knownQids = Object.keys(known);
  const inDataset = knownQids.filter((q) => byQid.has(q));
  const skippedMissing = knownQids.filter((q) => !byQid.has(q));
  console.log(`known-reverses entries: ${knownQids.length}`);
  console.log(`  in our dataset:        ${inDataset.length}`);
  console.log(`  not in dataset (skip): ${skippedMissing.length}`);

  console.log("Checking Wikidata for current P7417 state...");
  const state = await fetchWikidataState(inDataset);

  const missing = [];
  const alreadySet = [];
  for (const qid of inDataset) {
    const s = state.get(qid);
    if (!s) {
      console.log(`  ${qid}: no Wikidata response (skipping)`);
      continue;
    }
    if (s.hasReverse) {
      alreadySet.push(qid);
      continue;
    }
    missing.push({ qid, label: s.label });
  }
  console.log(`  P7417 already set: ${alreadySet.length} (${alreadySet.join(", ") || "none"})`);
  console.log(`  P7417 missing:     ${missing.length}`);

  console.log("Searching Commons for reverse-image candidates...");
  const enriched = [];
  for (const m of missing) {
    const flag = byQid.get(m.qid);
    const knownEntry = known[m.qid] ?? {};
    const period = knownEntry.period ?? null;
    const isHistorical = Boolean(knownEntry.historical);
    process.stdout.write(`  ${m.qid} ${m.label}... `);
    const reverseCandidates = await searchCommonsReverse(flag.name ?? m.label, period);
    // For historical rows we also surface obverse candidates so an editor
    // creating a new entity has both sides ready.
    const obverseCandidates = isHistorical
      ? await searchCommonsHistoricalObverse(flag.name ?? m.label, period)
      : [];
    process.stdout.write(
      `${reverseCandidates.length} reverse, ${obverseCandidates.length} obverse\n`,
    );
    for (const c of reverseCandidates) process.stdout.write(`      ↩ ${c}\n`);
    for (const c of obverseCandidates) process.stdout.write(`      ↪ ${c}\n`);
    enriched.push({
      qid: m.qid,
      name: flag.name ?? m.label,
      count: flag.count ?? 0,
      period,
      // `historical` (if present) carries a human-readable note about the
      // entity/period mismatch — e.g. "Listed entity is the modern flag;
      // only the 1908–1971 version had a distinct reverse." Editors should
      // create a NEW Wikidata entity for the historical flag rather than
      // adding P7417 to the modern entity.
      historical: knownEntry.historical ?? null,
      reverseCandidates,
      obverseCandidates,
    });
  }

  // Sort by OSM count descending so the highest-impact fixups bubble up.
  enriched.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  const out = {
    generated: new Date().toISOString(),
    note: "Flags this site believes have distinct reverse sides but whose Wikidata entity has no P7417 statement. Source list: data/known-reverses.json (bootstrapped from the English Wikipedia 'List of flags with reverses that differ from the obverse'). Add P7417 on Wikidata to populate.",
    candidates: enriched,
  };

  if (DRY) {
    console.log("\n--dry: not writing data/missing-p7417.json");
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const path = join(DATA_DIR, "missing-p7417.json");
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(out, null, 2) + "\n");
  await rename(tmp, path);
  console.log(`\nWrote ${path} (${enriched.length} candidates).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
