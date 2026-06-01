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
  "OSM-Flag-Identifier/0.1 (https://github.com/watmildon/osm-wikidata-flag-id-tools; build-flags.mjs)";

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
  "red", "white", "blue", "darkblue", "lightblue", "green", "yellow",
  "black", "orange", "brown", "purple", "pink", "gray",
];

// Wikidata color QIDs -> palette slug. Canonical color entities verified
// against the Wikidata label service (each QID is wdt:P31/wdt:P279* Q1075,
// "color"). Add aliases here as you discover new ones in P462 statements.
const COLOR_QID_MAP = {
  Q3142: "red",
  Q303826: "red",       // crimson
  Q23444: "white",
  Q1088: "blue",
  Q5975887: "blue",     // navy blue
  Q1602687: "lightblue",
  Q373160: "lightblue", // sky blue
  Q373058: "lightblue", // azure
  Q3133: "green",
  Q864152: "green",     // olive
  Q943: "yellow",
  Q208045: "yellow",    // gold
  Q23445: "black",
  Q39338: "orange",
  Q47071: "brown",
  Q3257809: "purple",
  Q428124: "purple",    // violet
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

// Like writeJsonAtomic, but skips the write entirely when the payload is
// identical to what's already on disk. Two reasons we want this: (1) for
// files with a `generated` timestamp at the top level we don't want a
// "every build touched it" diff when nothing else moved; (2) even for
// timestamp-free files, rewriting identical content still bumps the mtime
// and trips git's stat cache into reporting phantom changes on Windows.
// Returns true if a write happened.
async function writeJsonAtomicIfChanged(path, value) {
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (jsonEqualIgnoringGenerated(existing, value)) return false;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await writeJsonAtomic(path, value);
  return true;
}

function jsonEqualIgnoringGenerated(a, b) {
  const strip = (v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && "generated" in v) {
      const { generated: _, ...rest } = v;
      return rest;
    }
    return v;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
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
  await writeJsonAtomicIfChanged(join(CACHE_DIR, name), value);
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

// Numeric sort key for QIDs so canonical on-disk order is Q1 < Q2 < ... <
// Q100 instead of Q1 < Q10 < Q100 < Q2 (lexicographic) which would also be
// stable but harder for humans to scan.
function qidSortKey(qid) {
  return Number(qid.slice(1));
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
    # Accept either Q69506823 (flag design) or Q14660 (flag) ancestry.
    # In Wikidata these are sibling concepts, not parent/child, so we have
    # to test both. Specialized subtypes like municipal flag (Q21850100),
    # commercial flag (Q74051479), and bare "flag" (Q14660) all descend
    # from Q14660 but not Q69506823, and were previously failing the check.
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

// Find every P163 flag entity the candidate subjects point at, regardless of
// whether the target entity itself is a properly-classified flag with an image.
// We include the stubs intentionally: shifting OSM tags off the subject QID
// onto the dedicated flag entity is still a net improvement even when the
// flag entity itself needs Wikidata cleanup afterwards. `target_is_stub` on
// each suggestion lets the UI warn the mapper when that's the case.
const REVIEW_SPARQL_TEMPLATE = `
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
      const isFlagEntity = row.isFlagEntity?.value === "true";
      const hasImage = Boolean(row.image?.value);
      const suggestion = {
        bad_qid: itemQid,
        bad_name: cand.name,
        count: cand.count,
        suggested_qid: flagQid,
        suggested_name: row.flagLabel?.value ?? flagQid,
      };
      // Flag stub targets — the suggested flag entity isn't itself a properly
      // classified flag, or has no image. Still a worthwhile OSM-side swap, but
      // the UI should warn that the target needs Wikidata cleanup.
      if (!isFlagEntity || !hasImage) {
        suggestion.target_is_stub = true;
      }
      suggestions.push(suggestion);
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
// NSI (Name Suggestion Index) and Overpass flag:type/flag:name inference
// have been moved out of the main build to honor a "we are the source of
// truth" model:
//   - scripts/refresh-nsi.mjs       — re-merge NSI tags into flags.json
//   - scripts/refresh-overpass.mjs  — re-infer flag:type/flag:name from mapper consensus
// ---------------------------------------------------------------------------

// Score a candidate Commons filename for "looks like the canonical flag image"
// so we can prefer the right P18 when an entity has several (canonical SVG,
// photo, construction sheet, waving variant, etc.). Higher is better.
function imageScore(filename) {
  const name = filename.toLowerCase();
  const isSvg = name.endsWith(".svg");
  // Heavy penalty for known "not the canonical flag" variants.
  const isVariant = /construction|specification|sheet|diagram|drawing|template|measurements|grid|waving|wavy|photo|photograph|hoisted|raised|ceremony|3d|render/.test(name);
  // Coat-of-arms / shield images: many Wikidata entities (Swiss cantons,
  // some municipalities) have P18 pointing at the shield rather than the
  // actual flag. When the entity has BOTH images on Commons, the flag is
  // what we want. Penalize but don't disqualify — for entities whose only
  // P18 is the shield, we still want to show something.
  const isShield = /\bwappen\b|\bcoat[\s_-]*of[\s_-]*arms\b|\bcoa\b|\bescudo\b|\bblas[oó]n\b|\bstemma\b/.test(name);
  let score = 0;
  if (isSvg) score += 100;
  if (!isVariant) score += 50;
  if (!isShield) score += 30;
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
  // wdColors: raw Wikidata-derived palette. Persisted separately from `colors`
  // so the suggestions page can diff the two (Wikidata may lack P462 while
  // our overrides/curation has supplied colors, or the counts may disagree).
  // `colors` is the canonical site-facing list — starts equal to wdColors,
  // gets clobbered by overrides.json downstream.
  const wdColors = [
    ...new Set(colorQids.map((q) => COLOR_QID_MAP[q]).filter(Boolean)),
  ];
  const colors = [...wdColors];

  const width = row?.w ? Number(row.w.value) : null;
  const height = row?.h ? Number(row.h.value) : null;
  const shape = shapeFromDimensions(width, height);

  return {
    qid, name, count, file, isFlagEntity, colors, wdColors, icons: [], shape,
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
  // Withheld images and localFile overrides shouldn't keep cached thumbnails
  // — treat them as not-live so any prior-cached PNG gets cleaned up. The
  // localFile case matters when a record previously used Wikidata's image
  // and now uses a side-channel one; the stale Wikidata PNG would otherwise
  // linger in flags/thumb forever.
  const live = new Set(
    flags.filter((f) => !f.imageWithheld && !f.localFile).map((f) => f.qid)
  );
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

  // localFile overrides skip the Commons download entirely — render.js serves
  // those direct from flags/local/<localFile>. Skip them here so we don't
  // re-fetch the now-irrelevant Wikidata image.
  const withImage = flags.filter((f) => f.file && !f.imageWithheld && !f.localFile);
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

// Hand-curated QIDs to include even when taginfo doesn't list them yet — lets
// the site act as a reference for flags that *should* be tagged on OSM, not
// just ones that already are. Seeds get count=0; if a seed later appears in
// taginfo, the real count takes over.
async function loadSeeds() {
  const path = join(DATA_DIR, "seeds.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const qids = Array.isArray(raw?.qids) ? raw.qids : [];
    return qids.filter((q) => /^Q\d+$/.test(q));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function main() {
  // We are the source of truth. The build:
  //   - refreshes taginfo counts for ALL known QIDs (cheap; counts shift constantly),
  //   - enriches NEW QIDs only via Wikidata (label, image, colors, isFlagEntity, dimensions),
  //   - never re-queries Wikidata for QIDs already in flags.json,
  //   - never queries Overpass for flag:type/flag:name inference (use scripts/refresh-overpass.mjs),
  //   - never queries NSI (use scripts/refresh-nsi.mjs).
  // Read the previous build; it's both the shrink guard's baseline AND the
  // "what do we already know" source.
  const previous = await readPreviousFlagsJson();
  let degraded = false;

  const existingByQid = new Map();
  if (previous?.flags) {
    for (const f of previous.flags) existingByQid.set(f.qid, f);
  }

  const rawValues = await fetchTaginfoValues();
  const initialCounts = explodeAndDedupe(rawValues);

  // Union in hand-curated seed QIDs (count=0 unless taginfo already has them).
  const seeds = await loadSeeds();
  let seededAdded = 0;
  for (const qid of seeds) {
    if (!initialCounts.has(qid)) {
      initialCounts.set(qid, 0);
      seededAdded++;
    }
  }
  if (seeds.length) {
    console.log(`seeds: ${seeds.length} curated QIDs (${seededAdded} not in taginfo).`);
  }

  // Detect Wikidata redirects only for NEW QIDs. The redirects cache makes
  // re-checking known QIDs a no-op anyway, but we narrow the input set up
  // front so we never even ask about QIDs we've already classified.
  const newQids = [...initialCounts.keys()].filter((q) => !existingByQid.has(q));
  console.log(`taginfo: ${initialCounts.size} unique QIDs (${newQids.length} new since last build).`);

  const { redirects, failedBatches: redirectFailedBatches } =
    await resolveRedirects(newQids);
  if (redirectFailedBatches > 0) degraded = true;

  // Combine NEW redirects with any redirects already encoded as aliases[] on
  // the previous build's records, so taginfo counts roll into the right canonical.
  const allRedirects = new Map(redirects);
  for (const [canonical, prev] of existingByQid) {
    for (const alias of prev.aliases ?? []) {
      if (!allRedirects.has(alias)) allRedirects.set(alias, canonical);
    }
  }
  const { qidCounts, aliases } = applyRedirects(initialCounts, allRedirects);

  // Enrich only QIDs that are genuinely new — i.e. weren't in the previous
  // flags.json and weren't introduced via a redirect to an existing canonical.
  const toEnrich = [...qidCounts.keys()].filter((q) => !existingByQid.has(q));
  console.log(`Enriching ${toEnrich.length} new QIDs via Wikidata (${qidCounts.size - toEnrich.length} reused from last build)...`);
  let wdByQid = new Map();
  let enrichFailedBatches = 0;
  if (toEnrich.length > 0) {
    const enriched = await enrichAll(new Map(toEnrich.map((q) => [q, qidCounts.get(q)])));
    wdByQid = enriched.byQid;
    enrichFailedBatches = enriched.failedBatches;
    if (wdByQid.size === 0) {
      throw new Error("Wikidata enrichment returned no data for new QIDs — refusing to continue");
    }
  }
  if (enrichFailedBatches > 0) degraded = true;

  // Build records: existing QIDs keep everything they had (with refreshed
  // count + possibly extended aliases); new QIDs get full enrichment.
  let flags = [];
  for (const [qid, count] of qidCounts) {
    const prev = existingByQid.get(qid);
    let rec;
    if (prev) {
      rec = { ...prev, count };
      if (aliases.has(qid)) {
        // Union: keep historical aliases, add any new redirect QIDs.
        const merged = new Set([...(prev.aliases ?? []), ...aliases.get(qid)]);
        rec.aliases = [...merged];
      }
    } else {
      rec = rowToFlag(qid, count, wdByQid.get(qid));
      if (!rec.flagName) rec.flagName = deriveFlagName(rec.name);
      if (aliases.has(qid)) rec.aliases = aliases.get(qid);
    }
    flags.push(rec);
  }

  // Sort by QID for canonical on-disk order. Consumers (index, curate, review)
  // re-sort by count at runtime. Disk-order matters because a stable sort keeps
  // git diffs minimal — sorting by count meant a single OSM tagging shift
  // reordered the array and made the entire file look changed.
  flags.sort((a, b) => qidSortKey(a.qid) - qidSortKey(b.qid));

  const overrides = await loadOverrides();
  flags = mergeOverrides(flags, overrides);

  // Validate localFile overrides — warn if the referenced file isn't actually
  // present in flags/local/. Doesn't fail the build (the override might be in
  // progress, or someone else's machine has it); just surfaces the mismatch.
  const localFileFlags = flags.filter((f) => f.localFile);
  for (const f of localFileFlags) {
    const path = join(ROOT, "flags", "local", f.localFile);
    if (!(await fileExists(path))) {
      console.log(`  ::warning:: ${f.qid} has localFile="${f.localFile}" but flags/local/${f.localFile} is missing`);
      degraded = true;
    }
  }

  const withImage = flags.filter((f) => f.file).length;
  const flagEntities = flags.filter((f) => f.isFlagEntity).length;
  console.log(
    `flags: ${flags.length} total | ${withImage} with image | ${flagEntities} pass flag-entity check` +
    (localFileFlags.length ? ` | ${localFileFlags.length} side-channel image${localFileFlags.length === 1 ? "" : "s"}.` : ".")
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
  // Sorted by QID for stable diffs; the review page re-sorts at runtime.
  const nonFlag = flags
    .filter((f) => !f.isFlagEntity)
    .map((f) => ({ qid: f.qid, name: f.name, count: f.count, file: f.file }))
    .sort((a, b) => qidSortKey(a.qid) - qidSortKey(b.qid));
  const nonFlagChanged = await writeJsonAtomicIfChanged(join(DATA_DIR, "non-flag-qids.json"), nonFlag);
  console.log(
    nonFlagChanged
      ? `Wrote data/non-flag-qids.json (${nonFlag.length} suspect QIDs).`
      : `data/non-flag-qids.json unchanged (${nonFlag.length} suspect QIDs).`,
  );

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
  // Sort by bad_qid for canonical on-disk order. The review page re-sorts
  // by count at runtime so the most-impactful mistakes still come first.
  reviewSuggestions.sort((a, b) => qidSortKey(a.bad_qid) - qidSortKey(b.bad_qid));

  const reviewChanged = await writeJsonAtomicIfChanged(join(DATA_DIR, "review.json"), {
    generated: new Date().toISOString(),
    suggestions: reviewSuggestions,
  });
  console.log(
    reviewChanged
      ? `Wrote data/review.json (${reviewSuggestions.length} suggested fixes).`
      : `data/review.json unchanged (${reviewSuggestions.length} suggested fixes).`,
  );

  console.log("Downloading thumbnails...");
  const failures = await downloadAllThumbs(flags);

  const out = {
    generated: new Date().toISOString(),
    palette: PALETTE,
    icons: [
      "text", "animal", "bird", "people", "plant",
      "star", "sun", "cross", "crescent", "circle",
      "horizontal-stripes", "vertical-stripes", "triangle", "diagonal",
      "weapon", "map", "building", "coa",
      "crown", "tools", "water", "ship",
    ],
    shapes: ["rectangle", "square", "pennant", "other"],
    flags,
  };
  const flagsChanged = await writeJsonAtomicIfChanged(join(DATA_DIR, "flags.json"), out);
  console.log(
    flagsChanged
      ? `Wrote data/flags.json (${flags.length} flags).`
      : `data/flags.json unchanged (${flags.length} flags).`,
  );

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
