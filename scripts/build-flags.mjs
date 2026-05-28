#!/usr/bin/env node
import { readFile, writeFile, mkdir, access, readdir, unlink, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const CACHE_DIR = join(ROOT, "data", ".cache");
const THUMB_DIR = join(ROOT, "flags", "thumb");
const FULL_DIR = join(ROOT, "flags", "full");

const USER_AGENT =
  "OSM-Flag-Identifier/0.1 (https://github.com/; build-flags.mjs)";

const FORCE = process.argv.includes("--force");
const ALLOW_SHRINK = process.argv.includes("--allow-shrink");
const ALLOW_MASS_PRUNE = process.argv.includes("--allow-mass-prune");

// Guard thresholds. If the new build is materially smaller than the previous
// one (taginfo outage, Wikidata schema change), abort rather than ship a
// broken site. Both can be overridden via CLI flags above.
const SHRINK_GUARD_THRESHOLD = 0.20;
const PRUNE_GUARD_THRESHOLD = 0.20;

// Exit codes the cron wrapper can act on.
const EXIT_OK = 0;
const EXIT_FATAL = 1;     // unrecoverable: nothing was written
const EXIT_GUARDED = 2;   // shrink/prune guard tripped: prior data preserved
const EXIT_PARTIAL = 3;   // build completed but with degraded data quality

const PALETTE = [
  "red", "white", "blue", "green", "yellow",
  "black", "orange", "lightblue", "brown", "purple",
];

// Wikidata color QIDs -> palette slug. Coverage is sparse; overrides.json
// carries most of the real signal.
const COLOR_QID_MAP = {
  Q3142: "red", Q34106: "red", Q83264: "red", Q156274: "red",
  Q23445: "white",
  Q1088: "blue", Q1316: "blue", Q42519: "blue",
  Q1602687: "lightblue", Q221695: "lightblue", Q319400: "lightblue",
  Q3133: "green", Q42603: "green", Q2453337: "green",
  Q943: "yellow", Q23010: "yellow", Q25381: "yellow",
  Q23392: "black",
  Q39338: "orange",
  Q47071: "brown",
  Q3257809: "purple", Q428124: "purple",
};

// ---------------------------------------------------------------------------
// Shared helpers used by every external fetch and every JSON write.
// ---------------------------------------------------------------------------

const FETCH_MAX_RETRIES = 4;

// fetchWithRetry centralizes 429 / 5xx / network-error retry-with-backoff for
// every upstream we touch. Honors Retry-After if the server sets it; otherwise
// exponential backoff starting at 2s, capped at 30s. Throws on terminal
// failure (network error after all retries, or 4xx that isn't 429).
async function fetchWithRetry(url, init = {}, label = url) {
  let attempt = 0;
  while (true) {
    let res, networkErr;
    try {
      res = await fetch(url, init);
    } catch (e) {
      networkErr = e;
    }

    const transient =
      networkErr ||
      (res && (res.status === 429 || res.status >= 500));

    if (transient && attempt < FETCH_MAX_RETRIES) {
      const ra = res ? Number(res.headers.get("retry-after")) : NaN;
      const wait = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 30_000)
        : Math.min(2_000 * 2 ** attempt, 30_000);
      const why = networkErr
        ? `network error: ${networkErr.message}`
        : `HTTP ${res.status}`;
      console.log(`  ${label}: ${why} — backing off ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 1}/${FETCH_MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }

    if (networkErr) throw networkErr;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return res;
  }
}

// Atomic JSON write: write to <path>.tmp, fsync, then rename. So a crash mid-
// write doesn't leave a half-written file readers will choke on.
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}

// Cache an arbitrary fetched payload so we can fall back to it if the upstream
// is down on a future run. Used for NSI (rare changes, GitHub raw outage is
// possible). Cache lives outside data/ so it doesn't ship to the static site.
async function readCache(name) {
  const path = join(CACHE_DIR, name);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeCache(name, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeJsonAtomic(join(CACHE_DIR, name), value);
}

// Strip "flag of " / "flag of the " from a Wikidata label so it matches the
// way OSM mappers tag flag:name. Used only as a fallback when Overpass has no
// dominant flag:name for this QID.
function deriveFlagName(label) {
  if (!label) return label;
  let s = label.trim();
  // Case-insensitive "flag of " or "Flag of " prefix.
  s = s.replace(/^flag of (the )?/i, "");
  return s;
}

// Shape vocabulary kept deliberately simple: the silhouette categories that
// matter for field identification. Aspect ratios (1:2 vs 2:3) aren't useful
// for picking a flag out of a lineup. Default to "rectangle" since the vast
// majority of flags are rectangular; overrides.json handles the exceptions
// (Switzerland/Vatican = square, Nepal = pennant).
function shapeFromDimensions(width, height) {
  if (width && height && width === height) return "square";
  return "rectangle";
}

// ---------------------------------------------------------------------------
// Step 1: pull all flag:wikidata values from taginfo.
// ---------------------------------------------------------------------------

async function fetchTaginfoValues() {
  const RP = 999;
  const all = [];
  console.log("Querying taginfo...");
  for (let page = 1; ; page++) {
    const url =
      "https://taginfo.openstreetmap.org/api/4/key/values" +
      `?key=flag%3Awikidata&page=${page}&rp=${RP}` +
      "&sortname=count&sortorder=desc";
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": USER_AGENT } },
      `taginfo p${page}`,
    );
    const json = await res.json();
    if (!Array.isArray(json.data) || typeof json.total !== "number") {
      throw new Error(`taginfo p${page}: unexpected payload shape`);
    }
    all.push(...json.data);
    console.log(`  taginfo page ${page}: ${json.data.length} values (total so far ${all.length}/${json.total}).`);
    if (all.length >= json.total || json.data.length === 0) break;
  }
  // Sanity floor — empty taginfo response would catastrophically wipe the site.
  if (all.length === 0) {
    throw new Error("taginfo returned 0 values — refusing to continue");
  }
  return all;
}

// Split semicolon-joined values into individual QIDs, keep the maximum count
// any QID was seen with. Returns Map<qid, count>. Invalid QIDs (not matching
// /^Q\d+$/) are dropped — these are tagging mistakes (URLs, names, etc.).
function explodeAndDedupe(rawValues) {
  const counts = new Map();
  let dropped = 0;
  for (const { value, count } of rawValues) {
    for (const raw of value.split(";")) {
      const qid = raw.trim();
      if (!/^Q\d+$/.test(qid)) {
        dropped++;
        continue;
      }
      // Multi-value entries imply each component is on count objects, so we
      // additively accumulate — closer to "how many OSM objects reference
      // this QID directly or as part of a list".
      counts.set(qid, (counts.get(qid) ?? 0) + count);
    }
  }
  console.log(
    `dedupe: ${counts.size} unique QIDs (dropped ${dropped} non-QID values).`
  );
  return counts;
}

// ---------------------------------------------------------------------------
// Step 1.5: Resolve Wikidata redirects.
//
// Some QIDs in taginfo point to entities that have been merged/redirected.
// SPARQL doesn't follow redirects silently — the dead QID just returns no
// data, and we end up with an empty record. Worse, mappers are still tagging
// the dead QID. We want to:
//   - Enrich against the canonical entity so the main page is usable.
//   - Roll the dead QID's taginfo count into the canonical's count.
//   - Surface the redirect on the review page so OSM tags get fixed.
// Wikidata exposes redirects via owl:sameAs: a redirect QID has it, a live
// entity doesn't.
// ---------------------------------------------------------------------------

async function resolveRedirectsBatch(qids, label) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = `
SELECT ?item ?canonical WHERE {
  VALUES ?item { ${values} }
  ?item owl:sameAs ?canonical .
}`;
  const res = await fetchWithRetry(
    "https://query.wikidata.org/sparql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ query }).toString(),
    },
    label,
  );
  const json = await res.json();
  const map = new Map();
  for (const row of json.results.bindings) {
    const from = row.item.value.split("/").pop();
    const to = row.canonical.value.split("/").pop();
    map.set(from, to);
  }
  return map;
}

async function resolveRedirects(qids) {
  console.log(`Checking ${qids.length} QIDs for Wikidata redirects...`);

  // Cached map of "we've seen this QID, here's what we found" (canonical QID
  // or "" for "confirmed not a redirect"). Skip QIDs we've already classified.
  const cached = (await readCache("redirects.json")) ?? {};
  const toQuery = qids.filter((q) => !(q in cached));
  console.log(`  ${toQuery.length} new (${qids.length - toQuery.length} from cache).`);

  const BATCH = 500;
  let failedBatches = 0;
  for (let i = 0; i < toQuery.length; i += BATCH) {
    const slice = toQuery.slice(i, i + BATCH);
    const label = `redirects ${i / BATCH + 1}/${Math.ceil(toQuery.length / BATCH)}`;
    console.log(`  ${label} (${slice.length} QIDs)...`);
    let map;
    try {
      map = await resolveRedirectsBatch(slice, label);
    } catch (e) {
      console.log(`    FAIL: ${e.message}`);
      failedBatches++;
      continue;
    }
    // Mark every queried QID: redirects -> canonical, others -> "".
    for (const q of slice) {
      cached[q] = map.get(q) ?? "";
    }
  }
  await writeCache("redirects.json", cached);

  // Build the active redirect map (only the QIDs we care about right now,
  // only the ones that actually redirect).
  const redirects = new Map();
  for (const q of qids) {
    const target = cached[q];
    if (target) redirects.set(q, target);
  }
  console.log(`Found ${redirects.size} redirected QIDs.`);
  return { redirects, failedBatches };
}

// Collapse redirected QIDs into their canonical targets. If the canonical is
// already in our list, merge counts; otherwise replace the redirect entry.
// Returns { qidCounts, aliases } where aliases is Map<canonical, [redirect, ...]>.
function applyRedirects(qidCounts, redirects) {
  if (redirects.size === 0) return { qidCounts, aliases: new Map() };
  const aliases = new Map();
  const out = new Map(qidCounts);

  for (const [bad, canonical] of redirects) {
    const badCount = out.get(bad) ?? 0;
    out.delete(bad);
    // Track which canonical QID swallowed which redirects.
    if (!aliases.has(canonical)) aliases.set(canonical, []);
    aliases.get(canonical).push(bad);
    // Add the redirect's count to the canonical (creating the entry if
    // necessary, since the canonical may not have been in taginfo).
    out.set(canonical, (out.get(canonical) ?? 0) + badCount);
  }
  console.log(`Collapsed ${redirects.size} redirects into ${aliases.size} canonical QIDs.`);
  return { qidCounts: out, aliases };
}

// ---------------------------------------------------------------------------
// Step 2: enrich each QID with Wikidata data (label, image, colors, is-flag).
// ---------------------------------------------------------------------------

// Group-concat all P18 images for an item into a single -separated
// string. Some flag entities have multiple P18 values (canonical flag, photo,
// construction sheet, waving variant); we pick the best one in JS via
// pickBestImage() below rather than depending on SPARQL row ordering.
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
    ?item wdt:P31/wdt:P279* wd:Q69506823 .
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

async function enrichBatch(qids, label) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = SPARQL_QUERY.replace("__VALUES__", values);
  const res = await fetchWithRetry(
    "https://query.wikidata.org/sparql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ query }).toString(),
    },
    label,
  );
  const json = await res.json();
  return json.results.bindings;
}

// Returns { byQid, failedBatches } so callers can detect a degraded enrich.
async function enrichAll(qidCounts) {
  const qids = [...qidCounts.keys()];
  const BATCH = 500;
  const byQid = new Map();
  let failedBatches = 0;
  for (let i = 0; i < qids.length; i += BATCH) {
    const slice = qids.slice(i, i + BATCH);
    const label = `SPARQL enrich ${i / BATCH + 1}/${Math.ceil(qids.length / BATCH)}`;
    console.log(`  ${label} (${slice.length} QIDs)...`);
    let rows;
    try {
      rows = await enrichBatch(slice, label);
    } catch (e) {
      // One bad SPARQL batch shouldn't kill the whole pipeline. Affected QIDs
      // will get default-empty enrichment (no label, no image).
      console.log(`    FAIL: ${e.message}`);
      failedBatches++;
      continue;
    }
    for (const row of rows) {
      const qid = row.item.value.split("/").pop();
      byQid.set(qid, row);
    }
  }
  return { byQid, failedBatches };
}

// ---------------------------------------------------------------------------
// Step 2.6: For QIDs that don't look like flag entities, ask Wikidata whether
// they have a P163 (flag) pointing to a real flag entity — the classic
// "mapper used Q142 (France) instead of Q43192 (flag of France)" mistake.
// Produces data/review.json with suggested fixes.
// ---------------------------------------------------------------------------

const REVIEW_SPARQL_TEMPLATE = `
SELECT ?item ?itemLabel ?flag ?flagLabel WHERE {
  VALUES ?item { __VALUES__ }
  ?item wdt:P163 ?flag .
  ?flag wdt:P31/wdt:P279* wd:Q69506823 .
  ?flag wdt:P18 ?image .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

async function reviewBatch(qids, label) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = REVIEW_SPARQL_TEMPLATE.replace("__VALUES__", values);
  const res = await fetchWithRetry(
    "https://query.wikidata.org/sparql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ query }).toString(),
    },
    label,
  );
  const json = await res.json();
  return json.results.bindings;
}

async function buildReviewSuggestions(flags) {
  // Only inspect QIDs that didn't pass the flag-entity check; those are the
  // candidates for "you tagged the wrong thing". Skip ones with no OSM uses.
  const candidates = flags.filter(
    (f) => !f.isFlagEntity && f.count >= 1
  );
  console.log(
    `Reviewing ${candidates.length} non-flag QIDs for suggested replacements...`
  );

  const BATCH = 500;
  const candByQid = new Map(candidates.map((f) => [f.qid, f]));
  const suggestions = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const label = `review SPARQL ${i / BATCH + 1}/${Math.ceil(candidates.length / BATCH)}`;
    console.log(`  ${label}...`);
    let rows;
    try {
      rows = await reviewBatch(slice.map((f) => f.qid), label);
    } catch (e) {
      console.log(`    FAIL: ${e.message}`);
      continue;
    }
    for (const row of rows) {
      const itemQid = row.item.value.split("/").pop();
      const cand = candByQid.get(itemQid);
      if (!cand) continue;
      const flagQid = row.flag.value.split("/").pop();
      // Skip self-references that shouldn't happen but might.
      if (flagQid === itemQid) continue;
      suggestions.push({
        bad_qid: itemQid,
        bad_name: cand.name,
        count: cand.count,
        suggested_qid: flagQid,
        suggested_name: row.flagLabel?.value ?? flagQid,
      });
    }
  }
  // Dedupe — a QID might match more than one P163 (e.g. country with multiple
  // flag variants). Keep the first; mapper can pick when fixing.
  const seen = new Set();
  const unique = [];
  for (const s of suggestions) {
    if (seen.has(s.bad_qid)) continue;
    seen.add(s.bad_qid);
    unique.push(s);
  }
  unique.sort((a, b) => b.count - a.count);
  console.log(`Found ${unique.length} suggested fixes.`);
  return unique;
}

// ---------------------------------------------------------------------------
// Step 2.7: Pull the Name Suggestion Index flagpole bundle. NSI is hand-
// curated by the iD editor team; if it covers our QID we want its values
// for flag:name, flag:type, plus the extra subject/country tags.
// Source: https://github.com/osmlab/name-suggestion-index (BSD-3-Clause).
// ---------------------------------------------------------------------------

const NSI_URL =
  "https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/data/flags/man_made/flagpole.json";

async function fetchNsi() {
  console.log("Querying Name Suggestion Index...");
  let json;
  let source = "fresh";
  try {
    const res = await fetchWithRetry(
      NSI_URL,
      { headers: { "User-Agent": USER_AGENT } },
      "NSI",
    );
    json = await res.json();
    await writeCache("nsi-flagpole.json", json);
  } catch (e) {
    console.log(`  NSI upstream failed: ${e.message}`);
    const cached = await readCache("nsi-flagpole.json");
    if (!cached) {
      console.log("  no NSI cache available — extra tags will be missing this build");
      return { byQid: new Map(), source: "missing" };
    }
    console.log("  falling back to cached NSI data");
    json = cached;
    source = "cache";
  }
  const byQid = new Map();
  for (const item of json.items ?? []) {
    const qid = item.tags?.["flag:wikidata"];
    if (qid) byQid.set(qid, item);
  }
  console.log(`NSI: ${byQid.size} flag entries${source === "cache" ? " (cached)" : ""}.`);
  return { byQid, source };
}

// ---------------------------------------------------------------------------
// Step 2.5: Overpass pass. For each QID with enough single-value usage,
// learn flag:type from what mappers actually tag.
// ---------------------------------------------------------------------------

// Thresholds picked deliberately (see plan):
// - MIN_SAMPLE: ignore QIDs with too few OSM elements to draw a conclusion.
//   The taginfo count is a useful prefilter but Overpass exact-match returns
//   only single-value usages, which is what we want.
// - DOMINANCE: a value has to be >=70% of single-value uses to win. Below
//   that, mappers disagree and we leave flag:type blank.
// - BATCH: union queries in groups so we make ~75 requests not 1,400+.
const OVERPASS_MIN_SAMPLE = 5;
const OVERPASS_DOMINANCE = 0.7;
const OVERPASS_BATCH = 20;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function buildOverpassQuery(qids) {
  const lines = qids.map((q) => `  nwr["flag:wikidata"="${q}"];`).join("\n");
  return `[out:json][timeout:120];\n(\n${lines}\n);\nout tags;`;
}

async function overpassBatch(qids, label) {
  const query = buildOverpassQuery(qids);
  const res = await fetchWithRetry(
    OVERPASS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ data: query }).toString(),
    },
    label,
  );
  const json = await res.json();
  // Group elements by flag:wikidata, then count flag:type AND flag:name.
  const byQid = new Map();
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const wd = tags["flag:wikidata"];
    if (!wd || !qids.includes(wd)) continue;
    if (!byQid.has(wd)) {
      byQid.set(wd, { total: 0, types: new Map(), names: new Map() });
    }
    const bucket = byQid.get(wd);
    bucket.total++;
    const ft = tags["flag:type"];
    if (ft) bucket.types.set(ft, (bucket.types.get(ft) ?? 0) + 1);
    const fn = tags["flag:name"];
    if (fn) bucket.names.set(fn, (bucket.names.get(fn) ?? 0) + 1);
  }
  return byQid;
}

function pickDominant(counts, total) {
  if (!total || total < OVERPASS_MIN_SAMPLE) return null;
  let top = null, topN = 0;
  for (const [val, n] of counts) {
    if (n > topN) { top = val; topN = n; }
  }
  if (!top) return null;
  return (topN / total) >= OVERPASS_DOMINANCE ? top : null;
}

async function inferFlagTypes(flags) {
  const eligible = flags.filter((f) => f.count >= OVERPASS_MIN_SAMPLE);
  console.log(
    `Overpass: ${eligible.length} QIDs eligible (count>=${OVERPASS_MIN_SAMPLE}) / ${flags.length} total.`
  );

  // Results keyed by QID: { type, source }
  const results = new Map();

  for (let i = 0; i < eligible.length; i += OVERPASS_BATCH) {
    const slice = eligible.slice(i, i + OVERPASS_BATCH);
    const qids = slice.map((f) => f.qid);
    process.stdout.write(
      `  Overpass batch ${i / OVERPASS_BATCH + 1}/${Math.ceil(eligible.length / OVERPASS_BATCH)} (${qids.length} QIDs)... `
    );
    const label = `Overpass ${i / OVERPASS_BATCH + 1}/${Math.ceil(eligible.length / OVERPASS_BATCH)}`;
    let byQid;
    try {
      byQid = await overpassBatch(qids, label);
    } catch (e) {
      // One bad batch shouldn't kill the whole pipeline.
      process.stdout.write(`FAIL: ${e.message}\n`);
      continue;
    }
    let typeInferred = 0, nameInferred = 0, missing = 0;
    for (const f of slice) {
      const bucket = byQid.get(f.qid);
      if (!bucket) { missing++; continue; }
      const t = pickDominant(bucket.types, bucket.total);
      const n = pickDominant(bucket.names, bucket.total);
      if (t || n) {
        results.set(f.qid, {
          type: t,
          name: n,
          sample: bucket.total,
        });
        if (t) typeInferred++;
        if (n) nameInferred++;
      }
    }
    process.stdout.write(
      `type=${typeInferred} name=${nameInferred} no-data=${missing}\n`
    );
    // Be polite — Overpass etiquette says ~few queries/min for heavy queries.
    await new Promise((r) => setTimeout(r, 1500));
  }

  return results;
}

// Score a candidate Commons filename for "looks like the canonical flag image"
// so we can prefer the right P18 when an entity has several (canonical SVG,
// photo, construction sheet, waving variant, etc.). Higher is better.
function imageScore(filename) {
  const name = filename.toLowerCase();
  const isSvg = name.endsWith(".svg");
  // Heavy penalty for known "not the canonical flag" variants.
  const isVariant = /construction|specification|sheet|diagram|drawing|template|measurements|grid|waving|wavy|photo|photograph|hoisted|raised|ceremony|3d|render/.test(name);
  let score = 0;
  if (isSvg) score += 100;
  if (!isVariant) score += 50;
  // Shorter names tend to be more canonical ("Flag of Thailand.svg" vs
  // "Flag of Thailand (construction sheet).svg").
  score -= name.length / 100;
  return score;
}

function pickBestImage(imagesStr) {
  if (!imagesStr) return null;
  const urls = imagesStr.split("").filter(Boolean);
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  // Score by filename, not URL.
  const scored = urls.map((u) => {
    const file = decodeURIComponent(u.split("Special:FilePath/").pop());
    return { url: u, file, score: imageScore(file) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

function rowToFlag(qid, count, row) {
  const name = row?.itemLabel?.value ?? qid;
  const image = pickBestImage(row?.images?.value);
  const file = image
    ? decodeURIComponent(image.split("Special:FilePath/").pop())
    : null;
  const isFlagEntity = row?.isFlag?.value === "true";

  const colorQids = (row?.colorQids?.value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const colors = [
    ...new Set(colorQids.map((q) => COLOR_QID_MAP[q]).filter(Boolean)),
  ];

  const width = row?.w ? Number(row.w.value) : null;
  const height = row?.h ? Number(row.h.value) : null;
  const shape = shapeFromDimensions(width, height);

  return {
    qid, name, count, file, isFlagEntity, colors, icons: [], shape,
    // flagType / flagName are populated later by the Overpass pass when there
    // is enough single-value OSM usage to draw a high-confidence conclusion.
    // flagName falls back to a label-strip of `name` after the Overpass pass.
    // extraTags is populated from the Name Suggestion Index (iD bundle) when
    // a match exists — adds subject, subject:wikidata, country.
    // aliases lists any redirect QIDs that were collapsed into this canonical
    // entry; review.json uses these to surface OSM tags still on the old QID.
    flagType: null,
    flagName: null,
    flagTypeSample: null,
    extraTags: {},
    aliases: [],
  };
}

// ---------------------------------------------------------------------------
// Step 3: download thumbnails. Skip if cached; placeholder used at render
// time, not stored, for QIDs without a P18 image.
// ---------------------------------------------------------------------------

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadThumb(file, qid, width, destDir) {
  const dest = join(destDir, `${qid}.png`);
  if (!FORCE && (await fileExists(dest))) return { skipped: true };
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": USER_AGENT }, redirect: "follow" },
      `${qid} ${width}px`,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return { bytes: buf.length };
  } catch (e) {
    return { error: e.message };
  }
}

// Read the previous flags.json (if any) for the shrink guard. Returns null on
// first run, propagates errors only if the file exists but won't parse.
async function readPreviousFlagsJson() {
  const path = join(DATA_DIR, "flags.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Shrink guard: if the new build has dramatically fewer flags than the
// previous one, abort. Catches taginfo outages that silently return 0 or
// schema changes that drop most QIDs. Returns true if it's safe to proceed.
function shrinkGuard(prev, newCount) {
  if (!prev || !Array.isArray(prev.flags) || prev.flags.length === 0) {
    return { ok: true };
  }
  const prevCount = prev.flags.length;
  if (newCount >= prevCount) return { ok: true };
  const drop = (prevCount - newCount) / prevCount;
  if (drop > SHRINK_GUARD_THRESHOLD) {
    return {
      ok: false,
      message:
        `Shrink guard: new build has ${newCount} flags vs previous ${prevCount} ` +
        `(${(drop * 100).toFixed(1)}% drop). ` +
        `Refusing to overwrite. Pass --allow-shrink to override.`,
    };
  }
  return { ok: true, note: `shrink ${(drop * 100).toFixed(1)}% (within threshold)` };
}

// Delete any cached PNGs whose QID is no longer in the live flag set. Runs
// after flags.json is written so we never delete a thumb we'd want next time.
// Refuses to remove more than PRUNE_GUARD_THRESHOLD of cached files without
// the --allow-mass-prune flag — catches a corrupted flags.json from emptying
// the entire thumbnail cache.
async function pruneOrphanThumbs(flags) {
  const live = new Set(flags.map((f) => f.qid));
  const orphans = [];
  let cached = 0;
  for (const dir of [THUMB_DIR, FULL_DIR]) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".png")) continue;
      cached++;
      const qid = entry.slice(0, -4);
      if (live.has(qid)) continue;
      orphans.push(join(dir, entry));
    }
  }
  if (orphans.length === 0) return { removed: 0 };

  const fraction = cached ? orphans.length / cached : 0;
  if (fraction > PRUNE_GUARD_THRESHOLD && !ALLOW_MASS_PRUNE) {
    console.log(
      `Prune guard: ${orphans.length} of ${cached} thumbnails (${(fraction * 100).toFixed(1)}%) ` +
      `would be deleted. Refusing. Pass --allow-mass-prune to override.`,
    );
    console.log("First 20 orphans that would have been removed:");
    for (const o of orphans.slice(0, 20)) console.log(`  ${o}`);
    return { removed: 0, blocked: true, candidates: orphans.length };
  }
  for (const o of orphans) await unlink(o);
  console.log(`Pruned ${orphans.length} orphan thumbnail files.`);
  return { removed: orphans.length };
}

async function downloadAllThumbs(flags) {
  await mkdir(THUMB_DIR, { recursive: true });
  await mkdir(FULL_DIR, { recursive: true });

  const withImage = flags.filter((f) => f.file);
  const failures = [];
  let done = 0;
  const total = withImage.length * 2;

  for (const f of withImage) {
    for (const [w, dir] of [[200, THUMB_DIR], [400, FULL_DIR]]) {
      const r = await downloadThumb(f.file, f.qid, w, dir);
      done++;
      if (r.error) {
        failures.push({ qid: f.qid, name: f.name, w, error: r.error });
        process.stdout.write(`  [${done}/${total}] ${f.qid} ${w}px FAIL ${r.error}\n`);
      } else if (r.skipped) {
        process.stdout.write(`  [${done}/${total}] ${f.qid} ${w}px (cached)\r`);
      } else {
        process.stdout.write(`  [${done}/${total}] ${f.qid} ${w}px ${(r.bytes / 1024).toFixed(1)} KB\r`);
        // ~2.5 req/s. Higher rates (5/s) provoked HTTP 429s from Commons.
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  process.stdout.write("\n");
  return failures;
}

// ---------------------------------------------------------------------------
// Step 4: merge overrides and write flags.json.
// ---------------------------------------------------------------------------

function mergeOverrides(flags, overrides) {
  return flags.map((f) => {
    const o = overrides[f.qid];
    return o ? { ...f, ...o } : f;
  });
}

async function loadOverrides() {
  const path = join(DATA_DIR, "overrides.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

async function main() {
  // Read previous build first so the shrink guard has something to compare to.
  const previous = await readPreviousFlagsJson();
  let degraded = false;

  const rawValues = await fetchTaginfoValues();
  const initialCounts = explodeAndDedupe(rawValues);

  // Detect and collapse Wikidata redirects before enrichment, so the dead
  // QIDs don't waste a SPARQL slot returning empty rows. Their counts roll
  // into the canonical entity; their identity is preserved in aliases[].
  const { redirects, failedBatches: redirectFailedBatches } =
    await resolveRedirects([...initialCounts.keys()]);
  if (redirectFailedBatches > 0) degraded = true;
  const { qidCounts, aliases } = applyRedirects(initialCounts, redirects);

  console.log(`Enriching ${qidCounts.size} QIDs via Wikidata...`);
  const { byQid: wdByQid, failedBatches: enrichFailedBatches } =
    await enrichAll(qidCounts);
  if (wdByQid.size === 0 && qidCounts.size > 0) {
    throw new Error("Wikidata enrichment returned no data — refusing to continue");
  }
  if (enrichFailedBatches > 0) degraded = true;

  let flags = [];
  for (const [qid, count] of qidCounts) {
    const rec = rowToFlag(qid, count, wdByQid.get(qid));
    if (aliases.has(qid)) rec.aliases = aliases.get(qid);
    flags.push(rec);
  }

  // Sort by OSM usage count descending — most-mapped surface first.
  flags.sort((a, b) => b.count - a.count);

  // Learn flag:type and flag:name from mapper consensus on OSM.
  console.log("Inferring flag:type and flag:name from Overpass...");
  const overpassResults = await inferFlagTypes(flags);
  for (const f of flags) {
    const r = overpassResults.get(f.qid);
    if (r) {
      f.flagType = r.type;
      f.flagName = r.name;
      f.flagTypeSample = r.sample;
    }
    if (!f.flagName) f.flagName = deriveFlagName(f.name);
  }
  const typed = flags.filter((f) => f.flagType).length;
  const named = flags.filter((f) => f.flagName && f.flagName !== f.name).length;
  console.log(`Inferred flag:type=${typed} flag:name overrides=${named} / ${flags.length} flags.`);

  // Layer NSI on top. iD's hand-curated bundle wins over our Overpass-derived
  // values for flag:name and flag:type so the tags we produce match exactly
  // what the iD editor would suggest for the same flag.
  const { byQid: nsi, source: nsiSource } = await fetchNsi();
  if (nsiSource !== "fresh") degraded = true;
  let nsiApplied = 0;
  for (const f of flags) {
    const item = nsi.get(f.qid);
    if (!item) continue;
    nsiApplied++;
    const t = item.tags ?? {};
    if (t["flag:name"]) f.flagName = t["flag:name"];
    if (t["flag:type"]) f.flagType = t["flag:type"];
    f.extraTags = {};
    if (t["subject"])          f.extraTags["subject"] = t["subject"];
    if (t["subject:wikidata"]) f.extraTags["subject:wikidata"] = t["subject:wikidata"];
    if (t["country"])          f.extraTags["country"] = t["country"];
  }
  console.log(`NSI applied to ${nsiApplied}/${flags.length} flags.`);

  const overrides = await loadOverrides();
  flags = mergeOverrides(flags, overrides);

  const withImage = flags.filter((f) => f.file).length;
  const flagEntities = flags.filter((f) => f.isFlagEntity).length;
  console.log(
    `flags: ${flags.length} total | ${withImage} with image | ${flagEntities} pass flag-entity check.`
  );

  // Shrink guard — run BEFORE any writes so a degraded build doesn't trash
  // the last-known-good site.
  const guard = shrinkGuard(previous, flags.length);
  if (!guard.ok && !ALLOW_SHRINK) {
    console.error(guard.message);
    process.exit(EXIT_GUARDED);
  }
  if (guard.note) console.log(guard.note);

  await mkdir(DATA_DIR, { recursive: true });

  // Diagnostic file: QIDs that don't pass the Wikidata flag-design check.
  const nonFlag = flags
    .filter((f) => !f.isFlagEntity)
    .map((f) => ({ qid: f.qid, name: f.name, count: f.count, file: f.file }));
  await writeJsonAtomic(join(DATA_DIR, "non-flag-qids.json"), nonFlag);
  console.log(`Wrote data/non-flag-qids.json (${nonFlag.length} suspect QIDs).`);

  // For the non-flag QIDs, ask Wikidata whether each has a P163 pointing to a
  // real flag entity. Those are the high-confidence "you tagged the wrong
  // entity" cases mappers can fix.
  const reviewSuggestions = await buildReviewSuggestions(flags);

  // Redirect suggestions: a mapper is tagging a redirected QID. The canonical
  // QID lives in our flags list (with the redirect in aliases[]). Surface the
  // original count attribution so the mapper sees the volume.
  for (const f of flags) {
    if (!f.aliases || f.aliases.length === 0) continue;
    for (const bad of f.aliases) {
      const badCount = initialCounts.get(bad) ?? 0;
      if (badCount === 0) continue;
      reviewSuggestions.push({
        bad_qid: bad,
        bad_name: `(Wikidata redirect)`,
        count: badCount,
        suggested_qid: f.qid,
        suggested_name: f.name,
        reason: "redirect",
      });
    }
  }
  reviewSuggestions.sort((a, b) => b.count - a.count);

  await writeJsonAtomic(join(DATA_DIR, "review.json"), {
    generated: new Date().toISOString(),
    suggestions: reviewSuggestions,
  });
  console.log(`Wrote data/review.json (${reviewSuggestions.length} suggested fixes).`);

  console.log("Downloading thumbnails...");
  const failures = await downloadAllThumbs(flags);

  const out = {
    generated: new Date().toISOString(),
    palette: PALETTE,
    icons: ["text", "animal", "people", "star", "cross", "stripes", "circle", "crescent", "coa"],
    shapes: ["rectangle", "square", "pennant", "other"],
    flags,
  };
  await writeJsonAtomic(join(DATA_DIR, "flags.json"), out);
  console.log(`Wrote data/flags.json (${flags.length} flags).`);

  // Remove cached thumbnails for QIDs no longer present in the live set.
  const pruneResult = await pruneOrphanThumbs(flags);
  if (pruneResult.blocked) degraded = true;

  if (failures.length) {
    degraded = true;
    console.log(`\n${failures.length} thumbnail download failures:`);
    for (const f of failures) {
      console.log(`  ${f.qid} ${f.name} @${f.w}px: ${f.error}`);
    }
  }

  if (degraded) {
    console.log("\nBuild completed with degraded data — see warnings above.");
    process.exit(EXIT_PARTIAL);
  }
  console.log("\nBuild completed clean.");
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error(e);
  process.exit(EXIT_FATAL);
});
