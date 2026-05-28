#!/usr/bin/env node
// Merge two or more overrides.json files (e.g. from separate curators) into
// data/overrides.json, with per-field conflict detection.
//
// Usage:
//   node scripts/merge-overrides.mjs alice.json bob.json
//   node scripts/merge-overrides.mjs --dry alice.json bob.json   # print plan, don't write
//   node scripts/merge-overrides.mjs --base=data/overrides.json alice.json bob.json
//
// Behavior:
//   - Reads --base (default: data/overrides.json) as the existing committed
//     state.
//   - Layers each input file on top in argument order. Later inputs win on
//     conflict, but every conflict is reported.
//   - A conflict is "same QID, same field, different value". Arrays are
//     compared as sets (colors/icons are unordered).
//   - Adding a field the base lacked, or adding a whole new QID, isn't a
//     conflict — it's just an addition.
//   - Output is sorted numerically by QID to match the project's canonical
//     on-disk order.
//   - Exit codes: 0 clean, 1 unresolved conflicts (still written; review the
//     report), 2 fatal (bad input, can't read files).

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_BASE = join(ROOT, "data", "overrides.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const baseArg = args.find((a) => a.startsWith("--base="));
const BASE_PATH = baseArg ? resolve(baseArg.slice("--base=".length)) : DEFAULT_BASE;
const inputs = args.filter((a) => !a.startsWith("--"));

if (inputs.length === 0) {
  console.error("usage: node scripts/merge-overrides.mjs [--dry] [--base=path] <input.json> [...]");
  process.exit(2);
}

function eqSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

// Field-aware value equality. colors/icons are unordered sets; everything
// else is JSON-string equality.
function eqValue(field, a, b) {
  if (field === "colors" || field === "icons") return eqSet(a, b);
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadJson(path, allowMissing = false) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (allowMissing && e.code === "ENOENT") return {};
    console.error(`failed to read ${path}: ${e.message}`);
    process.exit(2);
  }
}

const base = await loadJson(BASE_PATH, true);
console.log(`base: ${BASE_PATH} (${Object.keys(base).length} entries)`);

const merged = structuredClone(base);
const conflicts = [];   // {qid, field, baseVal, sources: [{path, value}], winner}
const additions = [];   // {qid, field, value, source}
const newQids = [];     // {qid, source}

for (const path of inputs) {
  const overlay = await loadJson(resolve(path));
  console.log(`overlay: ${path} (${Object.keys(overlay).length} entries)`);
  for (const [qid, entry] of Object.entries(overlay)) {
    const existing = merged[qid];
    if (!existing) {
      merged[qid] = { ...entry };
      newQids.push({ qid, source: path });
      continue;
    }
    for (const [field, value] of Object.entries(entry)) {
      if (!(field in existing)) {
        existing[field] = value;
        additions.push({ qid, field, value, source: path });
        continue;
      }
      if (eqValue(field, existing[field], value)) continue;
      // Real conflict. Later input wins (for "last write wins" semantics),
      // but record it so the operator can decide.
      const prior = existing[field];
      existing[field] = value;
      // Coalesce into a single conflict record if multiple inputs disagree
      // on the same qid/field — easier to read.
      const open = conflicts.find((c) => c.qid === qid && c.field === field);
      if (open) {
        open.sources.push({ path, value });
        open.winner = path;
      } else {
        conflicts.push({
          qid, field,
          baseVal: base[qid]?.[field],
          sources: [
            { path: "(prior)", value: prior },
            { path, value },
          ],
          winner: path,
        });
      }
    }
  }
}

// Numeric QID sort to match the project's canonical on-disk order.
const sorted = {};
for (const k of Object.keys(merged).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
  sorted[k] = merged[k];
}

// ---- report ----

console.log();
console.log(`additions:    ${additions.length} (new field on existing QID)`);
console.log(`new QIDs:     ${newQids.length}`);
console.log(`conflicts:    ${conflicts.length}`);
console.log();

if (conflicts.length > 0) {
  console.log("CONFLICTS (later input wins; review and adjust by hand if wrong):");
  for (const c of conflicts) {
    console.log(`  ${c.qid} . ${c.field}`);
    for (const s of c.sources) {
      console.log(`    ${s.path}: ${JSON.stringify(s.value)}`);
    }
    console.log(`    winner: ${c.winner}`);
  }
  console.log();
}

if (DRY) {
  console.log("--dry: not writing.");
  process.exit(conflicts.length > 0 ? 1 : 0);
}

// Atomic write (matches build script's pattern).
const text = JSON.stringify(sorted, null, 2) + "\n";
const tmp = `${BASE_PATH}.tmp`;
await writeFile(tmp, text);
await rename(tmp, BASE_PATH);
console.log(`wrote ${BASE_PATH} (${Object.keys(sorted).length} entries).`);

process.exit(conflicts.length > 0 ? 1 : 0);
