#!/usr/bin/env node
// Apply a downloaded overrides.json (from the curate / describe / review
// pages' "Export overrides.json" button) and rebuild flags.json so the
// site picks up the new values immediately.
//
// Usage:
//   node scripts/apply-overrides.mjs <path-to-downloaded-overrides.json>
//   node scripts/apply-overrides.mjs ~/Downloads/overrides.json
//
// What it does, in order:
//   1. Validates the input file is a JSON object whose values are objects.
//   2. Replaces data/overrides.json with the input (atomically; numerically
//      sorted by QID per the project's canonical convention).
//   3. Runs the same build pipeline as `npm run build` so flags.json (and
//      any new thumbnails) reflects the merged overrides.
//   4. Stages overrides.json, flags.json, non-flag-qids.json, review.json,
//      flags/thumb, flags/full — same set the nightly workflow stages.
//   5. Prints a diff stat so you know what's about to be committed.
//
// Leaves committing and pushing to you. Run `git status` / `git diff
// --cached` to inspect, then `git commit -m "apply curated overrides"
// && git push` when ready.

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OVERRIDES_PATH = join(ROOT, "data", "overrides.json");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/apply-overrides.mjs <path-to-overrides.json>");
  process.exit(2);
}

const inputPath = resolve(input);

// ---- 1. validate input ----

let inputText;
try { inputText = await readFile(inputPath, "utf8"); }
catch (e) { console.error(`cannot read ${inputPath}: ${e.message}`); process.exit(2); }

let inputObj;
try { inputObj = JSON.parse(inputText); }
catch (e) { console.error(`${inputPath}: invalid JSON: ${e.message}`); process.exit(2); }

if (!inputObj || typeof inputObj !== "object" || Array.isArray(inputObj)) {
  console.error(`${inputPath}: expected a JSON object keyed by QID`);
  process.exit(2);
}

// Sanity check: every value should be an object too. A bad file (e.g. the
// old sparse describe-edits.json format which was {qid: "string text"})
// would silently break things if we wrote it without checking.
const badKeys = [];
for (const [qid, val] of Object.entries(inputObj)) {
  if (!/^Q\d+$/.test(qid)) badKeys.push(`${qid} (not a QID)`);
  else if (val === null || typeof val !== "object" || Array.isArray(val)) {
    badKeys.push(`${qid} (value isn't an object)`);
  }
}
if (badKeys.length > 0) {
  console.error(`${inputPath}: ${badKeys.length} malformed entries:`);
  for (const b of badKeys.slice(0, 10)) console.error(`  ${b}`);
  if (badKeys.length > 10) console.error(`  ... and ${badKeys.length - 10} more`);
  process.exit(2);
}

console.log(`input: ${inputPath} — ${Object.keys(inputObj).length} entries`);

// ---- 2. diff against current overrides ----

let current = {};
try { current = JSON.parse(await readFile(OVERRIDES_PATH, "utf8")); }
catch (e) { if (e.code !== "ENOENT") throw e; }

let identical = 0, divergent = 0, newKeys = 0, removedKeys = 0;
for (const qid of new Set([...Object.keys(inputObj), ...Object.keys(current)])) {
  if (!(qid in inputObj)) removedKeys++;
  else if (!(qid in current)) newKeys++;
  else if (JSON.stringify(inputObj[qid]) === JSON.stringify(current[qid])) identical++;
  else divergent++;
}
console.log(`vs current overrides.json: ${identical} identical, ${divergent} changed, ${newKeys} new, ${removedKeys} removed`);

if (identical === Object.keys(inputObj).length && newKeys === 0 && removedKeys === 0) {
  console.log("input is byte-identical to current overrides.json — nothing to do.");
  process.exit(0);
}

// ---- 3. write the new overrides.json ----

// Numeric QID sort to match canonical on-disk order (Q42 < Q100).
const sorted = {};
for (const k of Object.keys(inputObj).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
  sorted[k] = inputObj[k];
}
const text = JSON.stringify(sorted, null, 2) + "\n";
const tmp = `${OVERRIDES_PATH}.tmp`;
await writeFile(tmp, text);
await rename(tmp, OVERRIDES_PATH);
console.log(`wrote data/overrides.json (${Object.keys(sorted).length} entries).`);

// ---- 4. run the build ----

console.log();
console.log("running npm run build...");
console.log();

const build = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "inherit",
});
const buildCode = await new Promise((res) => build.on("close", res));
if (buildCode !== 0) {
  console.error(`\nbuild failed with exit code ${buildCode}.`);
  console.error("data/overrides.json HAS been updated; flags.json may be inconsistent.");
  console.error("fix the build error, re-run `npm run build`, then commit.");
  process.exit(buildCode);
}

// ---- 5. stage changes ----

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
    "flags/thumb",
    "flags/full",
    "flags/local",
  ],
  { cwd: ROOT, stdio: "inherit" }
);
await new Promise((res) => stage.on("close", res));

const diff = spawn("git", ["diff", "--cached", "--stat"], { cwd: ROOT, stdio: "inherit" });
await new Promise((res) => diff.on("close", res));

console.log();
console.log("ready to commit. Suggested:");
console.log("  git commit -m \"apply curated overrides\"");
console.log("  git push");
