// Shared editing data layer for the curate / describe / review-* pages.
//
// Goals:
// - One localStorage bag, shared across pages. An edit made on review-colors
//   shows up on curate and vice versa.
// - Field-level smart-prune on load. If a pending value already matches the
//   committed (or original) baseline, it's dropped silently so the user
//   doesn't keep re-exporting work that's already in the file.
// - One export path. Every page produces a full merged overrides.json so
//   downstream tooling sees a single shape. The old sparse describe-edits.json
//   format is retired.
// - One FSA direct-save handle. Approved once via curate, available to every
//   page until the user revokes it.
//
// Storage keys are intentionally NEW (osm-flag-editing-*) so the migration
// from the old per-page keys (osm-flag-curate-pending, osm-flag-describe-
// pending) is explicit. See migrateLegacyPending() — runs once on init.

const STORAGE_KEY = "osm-flag-editing-pending";
const LEGACY_KEYS = ["osm-flag-curate-pending", "osm-flag-describe-pending"];
// Tracks which (qid, field) review slots this browser has already
// incremented, so a single curator can't bump the counter by reloading the
// page repeatedly. Lives in a separate key from the pending bag so Discard
// edits doesn't lose the fingerprint.
const REVIEWED_HERE_KEY = "osm-flag-editing-reviewed-here";

const IDB_NAME = "osm-flag-editing";
const IDB_STORE = "handles";
const IDB_KEY = "overrides";

// ---- IndexedDB (for FSA file handles) ----

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- value equality (matches the smart-prune semantics) ----

// Field-level deep equality with order-insensitive array comparison for
// arrays (colors and icons are conceptually sets even though we serialize
// them as arrays).
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    for (const x of a) if (!sb.has(x)) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!valuesEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// ---- module state ----

const state = {
  pending: {},   // {qid: {field: value, ...}}
  committed: {}, // {qid: {field: value, ...}}, fetched once at init
  byQid: null,   // {qid: flag} — set by initEditing once flags.json is loaded
};

const subscribers = new Set();
// Separate channel for "a value-changing edit reset a reviewed field's
// counter to 0". Pages subscribe to surface a toast so the curator sees
// that prior reviewers' approvals were invalidated.
const reviewResetSubscribers = new Set();

function emit() {
  for (const fn of subscribers) fn();
}
function emitReviewReset(qid, field, prevCount) {
  for (const fn of reviewResetSubscribers) fn({ qid, field, prevCount });
}

// ---- localStorage ----

function readPending() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"); }
  catch { return {}; }
}
function writePending() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.pending));
}

// One-shot migration: if a legacy per-page key has content, fold it into
// the new shared bag and DELETE the legacy keys. The delete is the
// important part — otherwise the migration re-runs on every page load,
// and the user can never actually clear their pending bag (Discard wipes
// the new key, reload, migration repopulates from the still-present
// legacy key).
function migrateLegacyPending() {
  let migrated = 0;
  for (const oldKey of LEGACY_KEYS) {
    let raw;
    try { raw = localStorage.getItem(oldKey); } catch { continue; }
    if (!raw) continue;
    // Whatever happens parsing it, remove the legacy key — we don't want
    // a malformed bag re-tried forever.
    try { localStorage.removeItem(oldKey); } catch {}
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    for (const [qid, entry] of Object.entries(obj)) {
      // Describe page stored `pending[qid] = "text string"` (a raw string,
      // not an object). Normalize to {description: "..."} for the shared
      // shape used by every other page.
      let normalized;
      if (typeof entry === "string") normalized = { description: entry };
      else if (entry && typeof entry === "object") normalized = { ...entry };
      else continue;
      // Don't clobber: if a newer in-session edit for this QID already exists
      // in the shared bag, keep that — only fold in legacy entries for QIDs
      // we haven't touched.
      if (qid in state.pending) continue;
      state.pending[qid] = normalized;
      migrated++;
    }
  }
  if (migrated > 0) writePending();
}

// ---- committed-overrides fetch ----

async function fetchCommitted() {
  try {
    const res = await fetch("data/overrides.json", { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {}
  return {};
}

// ---- smart-prune ----

// Walk pending edits; for each field that already matches the committed (or
// original flag) value, drop the field. Drop the whole QID entry if every
// field was pruned. Returns the number of QIDs fully removed (for the toast).
function smartPrune() {
  let prunedQids = 0;
  for (const qid of Object.keys(state.pending)) {
    const entry = state.pending[qid];
    const baseline = baselineFor(qid);
    for (const field of Object.keys(entry)) {
      if (valuesEqual(entry[field], baseline[field])) {
        delete entry[field];
      }
    }
    if (Object.keys(entry).length === 0) {
      delete state.pending[qid];
      prunedQids++;
    }
  }
  if (prunedQids > 0) writePending();
  return prunedQids;
}

// ---- baseline resolution ----

// "Baseline" = the value a pending edit should be compared against. Order
// of precedence: committed override > original flag record. (We DON'T
// include in-session pending here — that's what the pending IS.)
function baselineFor(qid) {
  const committed = state.committed[qid] ?? {};
  const flag = state.byQid?.get(qid) ?? {};
  // Spread flag first so committed wins on conflict, matching the build.
  return { ...flag, ...committed };
}

// ---- public API ----

// Initialize the editing layer. Pass the flag list so we have full baseline
// data; the function loads committed overrides and smart-prunes pending.
// Returns { prunedCount } — pages can show a toast if > 0.
export async function initEditing(flags) {
  state.byQid = new Map(flags.map((f) => [f.qid, f]));
  state.pending = readPending();
  migrateLegacyPending();
  state.committed = await fetchCommitted();
  const prunedCount = smartPrune();
  emit();
  return { prunedCount };
}

export function pendingCount() {
  return Object.keys(state.pending).length;
}

export function hasPending(qid) {
  return qid in state.pending;
}

// Effective value of a single field: pending > committed > flag.
export function effectiveField(qid, field) {
  const p = state.pending[qid];
  if (p && field in p) return p[field];
  const c = state.committed[qid];
  if (c && field in c) return c[field];
  return state.byQid?.get(qid)?.[field];
}

// Baseline value of a single field (no pending): committed > flag.
export function baselineField(qid, field) {
  return baselineFor(qid)[field];
}

// Is this field currently edited (pending differs from baseline)?
export function isEdited(qid, field) {
  const p = state.pending[qid];
  if (!p || !(field in p)) return false;
  return !valuesEqual(p[field], baselineField(qid, field));
}

// Set a field's pending value. If it equals the baseline, the pending
// entry is dropped (no-op edits don't dirty the bag). Emits change.
//
// Side effect: changing a value-bearing field (anything other than
// `reviews` itself) that has a non-zero review count invalidates the
// prior reviewers' approval — the reviews referred to a different value.
// Reset the count for that field to 0 and clear this browser's local
// fingerprint so the "Looks good" button can be re-pressed on the new
// value. A separate event (onReviewReset) fires so the page can toast.
export function setField(qid, field, value) {
  const baseline = baselineField(qid, field);
  const wasValueChange = !valuesEqual(value, baseline);
  const entry = state.pending[qid] ?? (state.pending[qid] = {});
  if (!wasValueChange) {
    delete entry[field];
    if (Object.keys(entry).length === 0) delete state.pending[qid];
  } else {
    entry[field] = value;
  }
  writePending();
  emit();
  // Stale-review check, AFTER the main write so the inner setField call
  // below sees the new pending state. Only runs when:
  //   - We're changing a real value (not a no-op edit).
  //   - The field being changed isn't `reviews` itself (otherwise
  //     toggleReview / applyReviewDelta would loop).
  //   - The field has any reviews on the (post-edit) effective record.
  if (wasValueChange && field !== "reviews") {
    const reviews = effectiveField(qid, "reviews");
    const prevCount = (reviews && reviews[field]) || 0;
    if (prevCount > 0) {
      // Build the new reviews sub-object with this field removed, then
      // persist via setField so it gets normal smart-prune / export
      // treatment. The recursion is bounded: field === "reviews" skips
      // this branch.
      const merged = { ...reviews };
      delete merged[field];
      setField(qid, "reviews", Object.keys(merged).length === 0 ? undefined : merged);
      // Clear this browser's fingerprint for the slot too, so the
      // "Looks good" button reverts to its unreviewed appearance.
      const here = readReviewedHere();
      if (here[qid] && here[qid][field]) {
        delete here[qid][field];
        if (Object.keys(here[qid]).length === 0) delete here[qid];
        writeReviewedHere(here);
      }
      emitReviewReset(qid, field, prevCount);
    }
  }
}

// Clear all pending edits.
export function clearPending() {
  state.pending = {};
  writePending();
  emit();
}

// ---- review counter ----
//
// Each record can carry a `reviews` sub-object on its override:
//   "Q42537": { ..., "reviews": { "colors": 3, "icons": 1 } }
//
// Curators can mark a flag's field as "reviewed unchanged" (or after a
// change), bumping the corresponding sub-key by 1. The counter is purely
// curator-trust metadata; the build pipeline ignores it.
//
// De-dup: each browser stores a separate fingerprint of which (qid, field)
// slots it has already incremented (REVIEWED_HERE_KEY) so a reload-and-
// click-again loop can't inflate the number. Two browsers (or incognito
// tabs) count as two distinct reviewers — which is the right model since
// they're probably different people.

function readReviewedHere() {
  try { return JSON.parse(localStorage.getItem(REVIEWED_HERE_KEY) ?? "{}"); }
  catch { return {}; }
}
function writeReviewedHere(r) {
  localStorage.setItem(REVIEWED_HERE_KEY, JSON.stringify(r));
}

// Total review count for a (qid, field), including any in-session pending
// increments. Returns 0 when the field has never been reviewed.
export function reviewCount(qid, field) {
  const reviews = effectiveField(qid, "reviews");
  return (reviews && reviews[field]) || 0;
}

// Has THIS browser already incremented the (qid, field) review counter?
// Used by the UI to disable / change the button label after a click.
export function reviewedHere(qid, field) {
  const r = readReviewedHere();
  return Boolean(r[qid] && r[qid][field]);
}

// Adjust the (qid, field) review counter and the local fingerprint together.
// `delta` should be +1 (mark reviewed) or -1 (unmark). The counter floor is
// 0; an underflowed -1 is clamped. Returns the (possibly new) total count.
function applyReviewDelta(qid, field, delta) {
  // The pending `reviews` value is the FULL post-merge sub-object — pending
  // entries replace committed entries wholesale in mergedOverridesText, so
  // we have to carry every field forward, not just the one we changed.
  const baselineReviews = baselineField(qid, "reviews") ?? {};
  const pendingReviews = state.pending[qid]?.reviews ?? {};
  const merged = { ...baselineReviews, ...pendingReviews };
  const next = Math.max(0, (merged[field] ?? 0) + delta);
  if (next === 0) delete merged[field];
  else merged[field] = next;
  // If merged is now empty, drop the reviews field entirely so we don't
  // write an empty `{}` override.
  setField(
    qid,
    "reviews",
    Object.keys(merged).length === 0 ? undefined : merged,
  );
  return next;
}

// Increment the (qid, field) review counter by 1, recording locally that
// this browser did so. No-op if this browser already incremented this slot.
// Returns true if a new increment landed, false if it was a duplicate.
export function incrementReview(qid, field) {
  const here = readReviewedHere();
  if (here[qid] && here[qid][field]) return false;
  applyReviewDelta(qid, field, +1);
  here[qid] = here[qid] || {};
  here[qid][field] = true;
  writeReviewedHere(here);
  return true;
}

// Toggle this browser's review on (qid, field). If we haven't reviewed,
// behaves like incrementReview. If we have, decrements the counter by 1
// and clears the local fingerprint (so the user can undo a mistaken
// "Looks good" click). Returns the new reviewedHere state.
export function toggleReview(qid, field) {
  const here = readReviewedHere();
  const had = Boolean(here[qid] && here[qid][field]);
  if (had) {
    applyReviewDelta(qid, field, -1);
    delete here[qid][field];
    if (Object.keys(here[qid]).length === 0) delete here[qid];
  } else {
    applyReviewDelta(qid, field, +1);
    here[qid] = here[qid] || {};
    here[qid][field] = true;
  }
  writeReviewedHere(here);
  return !had;
}

// Get a snapshot of the pending bag (read-only by convention; the caller
// shouldn't mutate this — use setField).
export function snapshotPending() {
  return JSON.parse(JSON.stringify(state.pending));
}

// Subscribe to pending changes. Returns an unsubscribe fn.
export function onPendingChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Subscribe to "review counter was reset because a value changed".
// Callback receives { qid, field, prevCount }. Use it to toast the user
// so they know prior reviewers' approval was invalidated by their edit.
export function onReviewReset(fn) {
  reviewResetSubscribers.add(fn);
  return () => reviewResetSubscribers.delete(fn);
}

// ---- export ----

// Build the full overrides.json text: deep-merge pending into committed,
// then sort by numeric QID. This is what every page exports — there's no
// sparse-diff format any more.
export async function mergedOverridesText() {
  // Re-fetch committed at export time so we reflect any direct-save or
  // out-of-band edit that happened since init. Same reason curate does it.
  const base = await fetchCommitted();
  const merged = { ...base };
  for (const [qid, edit] of Object.entries(state.pending)) {
    merged[qid] = { ...(base[qid] ?? {}), ...edit };
  }
  const sorted = {};
  for (const k of Object.keys(merged).sort((a, b) =>
    Number(a.slice(1)) - Number(b.slice(1))
  )) {
    sorted[k] = merged[k];
  }
  return JSON.stringify(sorted, null, 2) + "\n";
}

// Try the File System Access API direct-save. Returns true on success,
// false if unsupported / user cancelled / permission denied. Uses a
// persistent handle in IndexedDB so subsequent saves are one-click.
export async function tryDirectSave(text) {
  if (typeof window.showSaveFilePicker !== "function") return false;
  let handle = await idbGet(IDB_KEY).catch(() => null);
  if (handle) {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") handle = null;
  }
  if (!handle) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: "overrides.json",
        types: [{
          description: "OSM Flag Identifier overrides",
          accept: { "application/json": [".json"] },
        }],
      });
      await idbSet(IDB_KEY, handle);
    } catch {
      return false;
    }
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  // The text we just wrote IS now the committed baseline. Update in-memory
  // and re-prune so the UI doesn't keep showing "N edits pending" for work
  // we just saved.
  try {
    state.committed = JSON.parse(text);
    smartPrune();
    emit();
  } catch {}
  return true;
}

export function downloadFallback(text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "overrides.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// One-call export: try direct save, fall back to download. Returns
// { method: "direct" | "download" } so the caller can toast accordingly.
export async function exportOverrides() {
  const text = await mergedOverridesText();
  const direct = await tryDirectSave(text);
  if (direct) return { method: "direct" };
  downloadFallback(text);
  return { method: "download" };
}
