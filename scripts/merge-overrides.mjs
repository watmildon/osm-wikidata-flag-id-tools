#!/usr/bin/env node
// Merge one or more curator-submitted overrides.json files into
// data/overrides.json. Designed for the case where multiple curators
// downloaded the same baseline, did independent offline reviews, and sent
// their files back at the same time.
//
// Per-field merge rules (applied independently for each (QID, field) slot,
// using set equality for `colors` / `icons` since those are unordered):
//
//   * No file touches this field          → keep the base value as-is.
//   * One file changes the field          → take the new value.
//   * Multiple files set the same value   → take that value.
//   * Multiple files set different values:
//       (a) For `colors` / `icons` arrays: if exactly one proposal is a
//           strict superset of every other proposal, take the superset.
//           Captures the common pattern of one reviewer expanding the
//           list while others pass through the base unchanged. The
//           non-expanding reviewers didn't actively review (they just
//           round-tripped), so no agreement bonus is awarded.
//       (b) Otherwise → CONFLICT. Field stays at the base value,
//           conflict is reported, other fields on the same QID still
//           merge normally.
//
// Reviews counter has two contributions, summed:
//
//   (a) Each file's own positive delta on `reviews.<field>` vs the base
//       count. A curator who explicitly pressed "Looks good" — bumping
//       their browser's counter from N to N+1 — registers a +1 here. A
//       file that just re-exported without touching the counter registers
//       +0.
//
//   (b) Multi-file agreement on a NEW value the base didn't have. If two
//       curators both set `icons: ["star"]` on a flag that previously had
//       no icons, the value clearly went in (+0 in (a) since neither
//       reviewed it as a separate action), and we add (N-1) here for the
//       agreeing reviewers beyond the first one (the first counts as the
//       setter, not a reviewer).
//
// A file that proposed a value LOSING a conflict has its review for that
// field dropped entirely — that curator was approving something else.
//
// Usage:
//   node scripts/merge-overrides.mjs file1.json file2.json [...]
//   node scripts/merge-overrides.mjs --dry file1.json
//   node scripts/merge-overrides.mjs --no-build file1.json
//   node scripts/merge-overrides.mjs --base=alt.json file1.json
//
// Flags:
//   --dry          Preview the merge; don't write, don't build, don't stage.
//   --no-build     Write the merged file but skip build + stage steps.
//   --base=path    Use a different baseline (default: data/overrides.json).
//
// Without --dry the script also runs `npm run build` and stages the
// generated files, same as `apply:overrides`. Conflicts are reported but
// never block the run; they're a heads-up that those fields stayed at the
// base value and need a human follow-up.

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_BASE = join(ROOT, "data", "overrides.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const NO_BUILD = args.includes("--no-build");
const baseArg = args.find((a) => a.startsWith("--base="));
const BASE_PATH = baseArg ? resolve(baseArg.slice("--base=".length)) : DEFAULT_BASE;
const inputPaths = args.filter((a) => !a.startsWith("--"));

if (inputPaths.length === 0) {
  console.error(
    "usage: node scripts/merge-overrides.mjs [--dry] [--no-build] [--base=path] <file.json> [...]",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Set equality for arrays — used for colors/icons since on-disk order
// isn't semantically meaningful. JSON-string equality for everything else.
function eqSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}
function eqValue(field, a, b) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (field === "colors" || field === "icons") return eqSet(a, b);
  return JSON.stringify(a) === JSON.stringify(b);
}

// True if `bigger` is a strict superset of `smaller` (every element of
// `smaller` is also in `bigger`, and `bigger` has at least one extra).
function isStrictSuperset(bigger, smaller) {
  if (!Array.isArray(bigger) || !Array.isArray(smaller)) return false;
  if (bigger.length <= smaller.length) return false;
  const big = new Set(bigger);
  for (const x of smaller) if (!big.has(x)) return false;
  return true;
}

// True if exactly one of `groups` proposes a value that is a strict
// superset of every other proposed value for the same field. Used to
// auto-resolve the "one reviewer expanded the list, others passed through
// the base" pattern that would otherwise be reported as a conflict.
function supersetGroupWins(groups, field) {
  if (field !== "colors" && field !== "icons") return false;
  if (groups.length < 2) return false;
  let supersetCount = 0;
  for (const g of groups) {
    if (isStrictSupersetOfAll(g.value, groups, field)) supersetCount++;
  }
  return supersetCount === 1;
}
function isStrictSupersetOfAll(candidate, groups, field) {
  if (field !== "colors" && field !== "icons") return false;
  let strictlyBigger = false;
  for (const g of groups) {
    if (eqSet(g.value, candidate)) continue;
    if (!isStrictSuperset(candidate, g.value)) return false;
    strictlyBigger = true;
  }
  return strictlyBigger;
}

function validate(label, obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${label}: expected a JSON object keyed by QID`);
  }
  const bad = [];
  for (const [qid, val] of Object.entries(obj)) {
    if (!/^Q\d+$/.test(qid)) bad.push(`${qid} (not a QID)`);
    else if (val === null || typeof val !== "object" || Array.isArray(val)) {
      bad.push(`${qid} (value isn't an object)`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `${label}: ${bad.length} malformed entries: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "..." : ""}`,
    );
  }
}

async function loadJson(path, { allowMissing = false } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (allowMissing && e.code === "ENOENT") return {};
    console.error(`failed to read ${path}: ${e.message}`);
    process.exit(2);
  }
}

// Reviewable fields. Mirrors editing.js — only these three have a
// per-field counter in the `reviews` sub-object.
const REVIEW_FIELDS = ["colors", "icons", "description"];

// ---------------------------------------------------------------------------
// Load inputs and base
// ---------------------------------------------------------------------------

const base = await loadJson(BASE_PATH, { allowMissing: true });
console.log(`base: ${BASE_PATH} (${Object.keys(base).length} entries)`);

const inputs = [];
for (const p of inputPaths) {
  const path = resolve(p);
  const obj = await loadJson(path);
  try { validate(path, obj); }
  catch (e) { console.error(e.message); process.exit(2); }
  inputs.push({ path, obj });
  console.log(`  loaded ${path} — ${Object.keys(obj).length} entries`);
}
console.log(`merging ${inputs.length} file${inputs.length === 1 ? "" : "s"}`);
console.log();

// ---------------------------------------------------------------------------
// Per-QID merge
// ---------------------------------------------------------------------------

const allConflicts = [];   // { qid, field, baseVal, proposals: [{value, paths}] }

function mergeQid(qid) {
  const baseEntry = base[qid] ?? {};
  const fileEntries = inputs
    .filter((f) => qid in f.obj)
    .map((f) => ({ path: f.path, entry: f.obj[qid] }));

  // Discover every non-reviews field any file touches.
  const fieldsTouched = new Set();
  for (const { entry } of fileEntries) {
    for (const k of Object.keys(entry)) {
      if (k !== "reviews") fieldsTouched.add(k);
    }
  }

  const merged = { ...baseEntry };
  const conflictedFields = new Set();
  // For each reviewable field that flipped to a NEW agreed-on value across
  // multiple files, count the "extra" agreeing files (paths.length - 1)
  // as additional confirmations the curators didn't separately log.
  const agreementBonuses = {}; // field -> count

  for (const field of fieldsTouched) {
    const baseVal = baseEntry[field];
    const proposals = fileEntries
      .map((f) => ({ path: f.path, value: f.entry[field] }))
      .filter((p) => p.value !== undefined);
    if (proposals.length === 0) continue;

    // Group proposals by equal value.
    const groups = [];
    for (const p of proposals) {
      const g = groups.find((x) => eqValue(field, x.value, p.value));
      if (g) g.paths.push(p.path);
      else groups.push({ value: p.value, paths: [p.path] });
    }

    if (groups.length === 1) {
      const { value, paths } = groups[0];
      const isNewValue = !eqValue(field, value, baseVal);
      if (isNewValue) merged[field] = value;
      // Multi-file agreement on a new value the base lacked: extras are
      // independent reviewers who saw the same value. Skip when the value
      // matches the base (no work was done) or when only one file touched
      // the field (no agreement to record).
      if (REVIEW_FIELDS.includes(field) && isNewValue && paths.length > 1) {
        agreementBonuses[field] = paths.length - 1;
      }
    } else if ((field === "colors" || field === "icons")
               && supersetGroupWins(groups, field)) {
      // Multi-reviewer pattern: one file expanded the array (added more
      // items), others just preserved the existing value. Strictly that's
      // a "disagreement" but contextually the expanding reviewer was the
      // one who looked at it. Take the superset.
      const winner = groups.find((g) => isStrictSupersetOfAll(g.value, groups, field));
      merged[field] = winner.value;
      // The non-superset reviewers didn't actively review (they just
      // round-tripped the base), so no agreement bonus.
    } else {
      // Disagreement. Field stays at base; record a conflict.
      conflictedFields.add(field);
      allConflicts.push({
        qid, field, baseVal,
        proposals: groups.map((g) => ({ value: g.value, paths: g.paths })),
      });
    }
  }

  // ---- reviews merge ----
  // For each reviewable field, sum positive deltas vs base from each file
  // whose value for that field agreed with the merged outcome. Conflicted
  // fields contribute nothing — those reviewers were looking at a value
  // that didn't win.
  //
  // If the merged value DIFFERS from the base value, the base reviews
  // count is stale (it referred to a different value) and resets to 0,
  // matching editing.js's setField behavior — the merge then adds
  // confirmations from files that agreed on the new value.
  const baseReviews = baseEntry.reviews ?? {};
  const mergedReviews = { ...baseReviews };
  for (const field of REVIEW_FIELDS) {
    if (conflictedFields.has(field)) continue;
    const winningValue = merged[field] ?? baseEntry[field];
    const valueChanged = !eqValue(field, winningValue, baseEntry[field]);
    const baseCount = valueChanged ? 0 : (baseReviews[field] ?? 0);
    if (valueChanged) delete mergedReviews[field];
    let delta = 0;
    for (const { entry } of fileEntries) {
      const fileReviews = entry.reviews ?? {};
      const fileCount = fileReviews[field];
      if (typeof fileCount !== "number") continue;
      // If this file set a value for `field` that doesn't match the
      // winning value, drop its review for that field. If the file didn't
      // set a value at all, it's reviewing the existing value — fine.
      const fileValue = entry[field];
      if (fileValue !== undefined && !eqValue(field, fileValue, winningValue)) continue;
      const diff = fileCount - baseCount;
      if (diff > 0) delta += diff;
    }
    if (agreementBonuses[field]) delta += agreementBonuses[field];
    const next = baseCount + delta;
    if (next > 0) mergedReviews[field] = next;
    else if (field in mergedReviews) delete mergedReviews[field];
  }
  if (Object.keys(mergedReviews).length > 0) merged.reviews = mergedReviews;
  else delete merged.reviews;

  return merged;
}

// Gather every QID mentioned anywhere.
const allQids = new Set(Object.keys(base));
for (const { obj } of inputs) for (const q of Object.keys(obj)) allQids.add(q);

const mergedAll = {};
for (const qid of allQids) {
  const m = mergeQid(qid);
  if (Object.keys(m).length > 0) mergedAll[qid] = m;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let touched = 0;
for (const qid of allQids) {
  const beforeStr = JSON.stringify(base[qid] ?? null);
  const afterStr = JSON.stringify(mergedAll[qid] ?? null);
  if (beforeStr !== afterStr) touched++;
}

console.log("per-file contribution:");
for (const { path, obj } of inputs) {
  let novel = 0, agreed = 0;
  for (const qid of Object.keys(obj)) {
    const baseEntry = base[qid] ?? {};
    const entry = obj[qid];
    for (const k of Object.keys(entry)) {
      if (k === "reviews") continue;
      if (eqValue(k, entry[k], baseEntry[k])) agreed++;
      else novel++;
    }
  }
  console.log(`  ${path}: ${novel} novel field-edits, ${agreed} agreed-with-base`);
}
console.log();

console.log(
  `overall: ${touched} QIDs touched, ${allConflicts.length} field-level conflict${allConflicts.length === 1 ? "" : "s"}`,
);
console.log();

if (allConflicts.length > 0) {
  console.log("CONFLICTS (field stays at base value, needs a human follow-up):");
  for (const c of allConflicts) {
    console.log(`  ${c.qid}.${c.field}`);
    console.log(`    base:  ${JSON.stringify(c.baseVal)}`);
    for (const p of c.proposals) {
      const files = p.paths.map((x) => x.split(/[\\/]/).pop()).join(", ");
      console.log(`    ${JSON.stringify(p.value)}  (from: ${files})`);
    }
  }
  console.log();
}

if (DRY) {
  console.log("--dry: not writing, not building, not staging.");
  process.exit(allConflicts.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Write merged overrides.json (numeric QID sort, canonical order)
// ---------------------------------------------------------------------------

const sorted = {};
for (const k of Object.keys(mergedAll).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
  sorted[k] = mergedAll[k];
}
const text = JSON.stringify(sorted, null, 2) + "\n";
const tmp = `${BASE_PATH}.tmp`;
await writeFile(tmp, text);
await rename(tmp, BASE_PATH);
console.log(`wrote ${BASE_PATH} (${Object.keys(sorted).length} entries).`);

if (NO_BUILD) {
  console.log("--no-build: skipping build + stage. Run `npm run build` yourself when ready.");
  process.exit(allConflicts.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Build + stage (same flow as apply:overrides)
// ---------------------------------------------------------------------------

console.log();
console.log("running npm run build...");
console.log();

// shell:true is required on Windows since Node 20+ tightened its spawn
// safety for .cmd / .bat files (spawn would otherwise throw EINVAL).
const build = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "build"],
  { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
);
const buildCode = await new Promise((res) => build.on("close", res));
if (buildCode !== 0) {
  console.error(`\nbuild failed with exit code ${buildCode}.`);
  console.error("data/overrides.json HAS been updated; flags.json may be inconsistent.");
  console.error("fix the build error, re-run `npm run build`, then commit.");
  process.exit(buildCode);
}

console.log();
console.log("staging changes...");
const stage = spawn(
  "git",
  ["add", "-A",
    "data/overrides.json",
    "data/flags.json",
    "data/non-flag-qids.json",
    "data/review.json",
    "data/.cache/redirects.json",
    "data/missing-flag-entities-auto.json",
    "data/missing-p7417.json",
    "flags/thumb",
    "flags/full",
    "flags/local",
  ],
  { cwd: ROOT, stdio: "inherit" },
);
await new Promise((res) => stage.on("close", res));

const diff = spawn("git", ["diff", "--cached", "--stat"], { cwd: ROOT, stdio: "inherit" });
await new Promise((res) => diff.on("close", res));

console.log();
console.log("ready to commit. Suggested:");
console.log(`  git commit -m "merge curated overrides from ${inputs.length} reviewer${inputs.length === 1 ? "" : "s"}"`);
console.log("  git push");

process.exit(allConflicts.length > 0 ? 1 : 0);
