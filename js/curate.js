import { loadFlags } from "./data.js";
import { showToast } from "./clipboard.js";
import { thumbSrc, fullSrc } from "./render.js";

// ---- constants ----

const STORAGE_KEY = "osm-flag-curate-pending";

const COLOR_SWATCHES = {
  red: "#dc2626", white: "#ffffff", blue: "#1d4ed8", green: "#16a34a",
  yellow: "#facc15", black: "#111827", orange: "#ea580c",
  lightblue: "#7dd3fc", brown: "#92400e", purple: "#7e22ce",
};
const ICON_LABELS = {
  text: "Text", animal: "Animal", bird: "Bird", people: "People", plant: "Plant",
  star: "Star", sun: "Sun", cross: "Cross", crescent: "Crescent", circle: "Circle",
  "horizontal-stripes": "Horizontal stripes", "vertical-stripes": "Vertical stripes",
  triangle: "Triangle", diagonal: "Diagonal",
  weapon: "Weapon", map: "Map", building: "Building", coa: "Coat of arms",
};
const SHAPE_LABELS = {
  rectangle: "Rectangle", square: "Square", pennant: "Pennant", other: "Other",
};

// Canonical OSM flag:type values per wiki.openstreetmap.org/wiki/Key:flag:type
// plus the popular non-canonical 'commercial' that mappers use.
const FLAG_TYPES = [
  "national", "regional", "municipal", "governmental", "military",
  "religious", "cultural", "indigenous", "athletic", "signal",
  "organisation", "advertising", "commercial", "historical",
];

// ---- state ----

let meta = null;          // full flags.json
let queue = [];           // ordered list of flag records to work through
let queueIndex = 0;
let edit = null;          // { colors:Set, icons:Set, shape:string|null } for current flag
let pending = loadPending(); // { qid: {colors, icons, shape} }
let committed = {};       // data/overrides.json as currently committed — layered
                          // into effective() so already-committed work doesn't
                          // reappear in the queue between builds.

// ---- IndexedDB helpers (for the File System Access API handle) ----
//
// localStorage can't store FileSystemFileHandle objects (they're not
// structured-clonable through JSON). IndexedDB can. One key, one value,
// no schema needed.

const IDB_NAME = "osm-flag-curate";
const IDB_STORE = "handles";
const IDB_KEY = "overrides";

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

async function idbDel(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- localStorage ----

function loadPending() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function savePending() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  updatePendingUI();
}

function updatePendingUI() {
  const n = Object.keys(pending).length;
  document.getElementById("pending-count").textContent = n;
  document.getElementById("export-btn").disabled = n === 0;
  document.getElementById("clear-pending-btn").disabled = n === 0;
}

// ---- queue ----

// Effective record = base flag merged with committed overrides and any pending
// in-session edit. Mirrors the precedence the build pipeline uses, so a flag
// the curator already classified (committed or in this session) doesn't keep
// resurfacing in the "needs attention" queue between builds.
function effective(f) {
  const c = committed[f.qid];
  const p = pending[f.qid];
  return c || p ? { ...f, ...(c ?? {}), ...(p ?? {}) } : f;
}

// Per-field "is missing" predicates. Each takes the effective record and
// returns true if that field needs a curator's attention.
const FIELD_PROBES = {
  description: (e) => !e.description,
  type:        (e) => !e.flagType,
  colors:      (e) => (e.colors?.length ?? 0) === 0,
  icons:       (e) => (e.icons?.length ?? 0) === 0,
  shape:       (e) => !e.shape,
};
const NEEDS_FIELDS = Object.keys(FIELD_PROBES);
const NEEDS_LABELS = {
  description: "description", type: "type",
  colors: "colors", icons: "icons", shape: "shape",
};
// Defaults: the two highest-leverage curator chores. Anything in the user's
// localStorage wins; falls back to these on first load.
const NEEDS_DEFAULT = ["description", "icons"];

const NEEDS_STORAGE_KEY = "osm-flag-curate-needs";
function loadNeeds() {
  try {
    const raw = JSON.parse(localStorage.getItem(NEEDS_STORAGE_KEY) ?? "null");
    if (Array.isArray(raw)) return new Set(raw.filter((k) => NEEDS_FIELDS.includes(k)));
  } catch {}
  return new Set(NEEDS_DEFAULT);
}
function saveNeeds() {
  localStorage.setItem(NEEDS_STORAGE_KEY, JSON.stringify([...needs]));
}
let needs = loadNeeds();

// OR-combine: a flag stays in the queue if AT LEAST ONE selected field is
// missing on its effective record. If no chips are selected, no filter is
// applied (curator sees everything).
function needsAttention(f) {
  if (needs.size === 0) return true;
  const e = effective(f);
  for (const k of needs) if (FIELD_PROBES[k](e)) return true;
  return false;
}

function buildQueue() {
  const hideNonFlag = document.getElementById("hide-non-flag-entities").checked;
  // flags.json is sorted by qid on disk for clean diffs; sort by count desc
  // here so the curator works highest-impact flags first.
  queue = meta.flags
    .filter((f) => (!hideNonFlag || f.isFlagEntity))
    .filter(needsAttention)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  queueIndex = 0;
}

// ---- chip rendering ----

function chip({ label, swatchColor, pressed, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip";
  btn.setAttribute("aria-pressed", String(pressed));
  if (swatchColor) {
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = swatchColor;
    btn.appendChild(sw);
  }
  const text = document.createElement("span");
  text.textContent = label;
  btn.appendChild(text);
  btn.addEventListener("click", onClick);
  return btn;
}

function renderChips() {
  const typeRoot = document.getElementById("type-chips");
  typeRoot.innerHTML = "";
  for (const t of FLAG_TYPES) {
    typeRoot.appendChild(chip({
      label: t,
      pressed: edit.flagType === t,
      onClick: () => { edit.flagType = edit.flagType === t ? null : t; renderChips(); },
    }));
  }
  const colorRoot = document.getElementById("color-chips");
  colorRoot.innerHTML = "";
  for (const c of meta.palette) {
    colorRoot.appendChild(chip({
      label: c, swatchColor: COLOR_SWATCHES[c],
      pressed: edit.colors.has(c),
      onClick: () => { edit.colors.has(c) ? edit.colors.delete(c) : edit.colors.add(c); renderChips(); },
    }));
  }
  const iconRoot = document.getElementById("icon-chips");
  iconRoot.innerHTML = "";
  for (const i of meta.icons) {
    iconRoot.appendChild(chip({
      label: ICON_LABELS[i] ?? i,
      pressed: edit.icons.has(i),
      onClick: () => { edit.icons.has(i) ? edit.icons.delete(i) : edit.icons.add(i); renderChips(); },
    }));
  }
  const shapeRoot = document.getElementById("shape-chips");
  shapeRoot.innerHTML = "";
  for (const s of meta.shapes) {
    shapeRoot.appendChild(chip({
      label: SHAPE_LABELS[s] ?? s,
      pressed: edit.shape === s,
      onClick: () => { edit.shape = edit.shape === s ? null : s; renderChips(); },
    }));
  }
}

// Topbar "needing attention" chips. One per field; label includes the count
// of flags missing that field across the dataset (computed against the
// effective record so committed/pending work is reflected). Click toggles.
function renderNeedsChips() {
  const root = document.getElementById("needs-chips");
  if (!root) return;
  // Count once per field per render.
  const counts = Object.fromEntries(NEEDS_FIELDS.map((k) => [k, 0]));
  for (const f of meta.flags) {
    const e = effective(f);
    for (const k of NEEDS_FIELDS) if (FIELD_PROBES[k](e)) counts[k]++;
  }
  root.innerHTML = "";
  for (const k of NEEDS_FIELDS) {
    root.appendChild(chip({
      label: `need ${NEEDS_LABELS[k]} ${counts[k].toLocaleString()}`,
      pressed: needs.has(k),
      onClick: () => {
        needs.has(k) ? needs.delete(k) : needs.add(k);
        saveNeeds();
        buildQueue();
        renderCurrent();
        renderNeedsChips();
      },
    }));
  }
}

// ---- flag detail ----

function renderCurrent() {
  if (queue.length === 0) {
    document.getElementById("flag-name").textContent = "Queue empty";
    document.getElementById("queue-pos").textContent = "0 of 0";
    document.getElementById("flag-img").src = "flags/placeholder.svg";
    document.getElementById("flag-img").alt = "";
    document.getElementById("flag-link").textContent = "";
    document.getElementById("flag-count").textContent = "—";
    document.getElementById("flag-entity-state").textContent = "";
    document.getElementById("name-input").value = "";
    document.getElementById("description-input").value = "";
    edit = { flagName: "", flagType: null, colors: new Set(), icons: new Set(), shape: null, description: "" };
    renderChips();
    return;
  }
  const f = queue[queueIndex];
  const e = effective(f);

  document.getElementById("queue-pos").textContent =
    `${queueIndex + 1} of ${queue.length}`;
  document.getElementById("flag-name").textContent = f.name;
  document.getElementById("flag-img").src = fullSrc(f);
  document.getElementById("flag-img").alt = `Flag: ${f.name}`;
  const link = document.getElementById("flag-link");
  link.href = `https://www.wikidata.org/wiki/${f.qid}`;
  link.textContent = f.qid;
  document.getElementById("flag-count").textContent = f.count.toLocaleString();
  document.getElementById("flag-entity-state").textContent =
    f.isFlagEntity ? "flag entity ✓" : "⚠️ not a flag entity";

  const nameInput = document.getElementById("name-input");
  nameInput.value = e.flagName ?? "";
  nameInput.placeholder = f.flagName ?? f.name;

  const descInput = document.getElementById("description-input");
  descInput.value = e.description ?? "";

  edit = {
    flagName: e.flagName ?? "",
    flagType: e.flagType ?? null,
    colors: new Set(e.colors ?? []),
    icons: new Set(e.icons ?? []),
    shape: e.shape ?? null,
    description: e.description ?? "",
  };
  renderChips();
}

// ---- actions ----

function commitCurrent() {
  if (queue.length === 0) return;
  const f = queue[queueIndex];
  const e = effective(f);
  // Snapshot the curator's intent into a sparse override. A scalar field is
  // written only when it differs from the effective value (base + committed)
  // — otherwise we'd write an in-session pending override that already matches
  // what's committed, then immediately smart-prune it on next page load.
  // Read input values live (the `input` events keep edit.* in sync, but be
  // defensive in case of unfocused-input edge cases).
  edit.flagName = document.getElementById("name-input").value.trim();
  edit.description = document.getElementById("description-input").value.trim();
  const entry = {};
  if (edit.flagName && edit.flagName !== (e.flagName ?? "")) {
    entry.flagName = edit.flagName;
  }
  if (edit.flagType && edit.flagType !== (e.flagType ?? null)) {
    entry.flagType = edit.flagType;
  }
  if (edit.colors.size) entry.colors = [...edit.colors];
  if (edit.icons.size) entry.icons = [...edit.icons];
  if (edit.shape) entry.shape = edit.shape;
  if (edit.description && edit.description !== (e.description ?? "")) {
    entry.description = edit.description;
  }
  if (Object.keys(entry).length === 0) delete pending[f.qid];
  else pending[f.qid] = entry;
  savePending();
}

function advance() {
  if (queueIndex + 1 < queue.length) {
    queueIndex++;
  } else if (queue.length === 1 && location.search) {
    // Direct-linked single-flag queue: after the user finishes their one
    // target, flow into the normal needing-attention queue rather than
    // showing "queue empty". Clear the ?qid= from the URL so a refresh
    // doesn't bounce them back here.
    history.replaceState(null, "", location.pathname);
    buildQueue();
  } else {
    queueIndex = queue.length; // signal "past the end"
  }
  renderCurrent();
}

function handleSave() {
  commitCurrent();
  // Counts on the topbar chips drift as the curator works; refresh them.
  renderNeedsChips();
  advance();
}

function handleSkip() {
  advance();
}

// ---- export ----

// Fetch the currently-committed overrides.json from the served site. If
// cache:no-store is honored, this returns whatever the user (or a previous
// direct-save) most recently wrote. Returns {} on any error so callers don't
// have to branch.
async function fetchCommittedOverrides() {
  try {
    const res = await fetch("data/overrides.json", { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {}
  return {};
}

// Walk pending edits; drop any whose JSON-stringified body is byte-identical
// to what's already in overrides.json. Returns the number pruned so the
// caller can toast it.
function pruneAlreadyCommitted(committed) {
  let pruned = 0;
  for (const [qid, entry] of Object.entries(pending)) {
    if (qid in committed) {
      if (JSON.stringify(entry) === JSON.stringify(committed[qid])) {
        delete pending[qid];
        pruned++;
      }
    }
  }
  if (pruned > 0) savePending();
  return pruned;
}

async function mergedOverridesText() {
  // Recompute against the latest committed state so a save reflects whatever
  // happened between this page load and now (another curator, another tab).
  //
  // Per-QID DEEP merge: the pending entry only carries fields the curator
  // touched (colors / icons / shape / flagName / flagType). Any other fields
  // present in the committed file — most importantly `description`, which
  // isn't editable here — must be preserved. A naive top-level spread would
  // replace the whole record and silently drop the description.
  const base = await fetchCommittedOverrides();
  const merged = { ...base };
  for (const [qid, edit] of Object.entries(pending)) {
    merged[qid] = { ...(base[qid] ?? {}), ...edit };
  }
  // Numeric QID sort (Q42 < Q100, not lexicographic Q100 < Q42). Matches the
  // canonical order convention documented in CLAUDE.md so diffs stay clean.
  const sorted = {};
  for (const k of Object.keys(merged).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    sorted[k] = merged[k];
  }
  return JSON.stringify(sorted, null, 2) + "\n";
}

async function tryDirectSave(text) {
  // Returns true if we successfully wrote via the File System Access API.
  // Returns false if the API isn't supported or the user cancelled the picker.
  if (typeof window.showSaveFilePicker !== "function") return false;

  let handle = await idbGet(IDB_KEY);
  if (handle) {
    // Verify we still have write permission. requestPermission may prompt
    // (typically once per session) but most browsers grant immediately for
    // a handle the user already approved.
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "readwrite" });
    }
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
    } catch (e) {
      // AbortError = user cancelled; fall back to download.
      return false;
    }
  }

  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return true;
}

function downloadFallback(text) {
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

async function handleExport() {
  const editCount = Object.keys(pending).length;
  const text = await mergedOverridesText();

  const direct = await tryDirectSave(text);
  if (direct) {
    // After a successful direct-save the committed file IS the file we just
    // wrote, so every pending edit is now redundant. Clear them.
    pending = {};
    savePending();
    showToast(`Saved ${editCount} edits to overrides.json`);
    return;
  }

  // Fallback: download. The user has to manually drop the file into place;
  // localStorage stays populated and will get smart-pruned next time we load
  // and detect the committed file matches.
  downloadFallback(text);
  showToast(`Downloaded ${editCount} edits — save into data/overrides.json`);
}

async function handleForgetSaveTarget() {
  // Exposed if the user wants to pick a different target file (e.g. moved
  // the repo). Not surfaced in UI yet; here so it's easy to add a button.
  await idbDel(IDB_KEY);
  showToast("Forgot saved file target");
}

function handleClearPending() {
  if (!confirm(`Discard ${Object.keys(pending).length} unsaved edits?`)) return;
  pending = {};
  savePending();
  // Counts may shift back up as in-session work disappears.
  renderNeedsChips();
  buildQueue();
  renderCurrent();
  showToast("Pending edits cleared");
}

function handleFilterChange() {
  buildQueue();
  renderCurrent();
}

// ---- boot ----

async function main() {
  meta = await loadFlags();

  // Load committed overrides once at startup. Two uses:
  //   1. Layered into effective() so the "needs attention" filter sees
  //      already-classified flags as classified, even when flags.json hasn't
  //      been rebuilt since the override was committed.
  //   2. Smart prune: if any pending edit is byte-identical to what's
  //      committed (curator saved last session, replaced the file, came
  //      back), drop it. Saves re-saving and prevents accidental clobbers.
  committed = await fetchCommittedOverrides();
  if (Object.keys(pending).length > 0) {
    const pruned = pruneAlreadyCommitted(committed);
    if (pruned > 0) {
      showToast(`Cleared ${pruned} edit${pruned === 1 ? "" : "s"} already in overrides.json`);
    }
  }

  renderNeedsChips();

  // Direct link from the identifier: `curate.html?qid=Q42537` jumps straight
  // to one flag, bypassing the needing-attention filter (the user picked a
  // specific record to fix and shouldn't be filtered away from it). If the
  // QID isn't in the dataset we fall back to the normal queue with a toast.
  const params = new URLSearchParams(location.search);
  const directQid = params.get("qid");
  if (directQid) {
    const target = meta.flags.find((f) => f.qid === directQid);
    if (target) {
      queue = [target];
      queueIndex = 0;
    } else {
      showToast(`${directQid} not in flags.json — falling back to queue`);
      buildQueue();
    }
  } else {
    buildQueue();
  }
  renderCurrent();
  updatePendingUI();

  document.getElementById("save-btn").addEventListener("click", handleSave);
  document.getElementById("skip-btn").addEventListener("click", handleSkip);
  document.getElementById("export-btn").addEventListener("click", handleExport);
  document.getElementById("clear-pending-btn").addEventListener("click", handleClearPending);
  document.getElementById("hide-non-flag-entities").addEventListener("change", handleFilterChange);

  // Keep edit state in sync with the text inputs as the curator types.
  document.getElementById("name-input").addEventListener("input", (e) => {
    edit.flagName = e.target.value;
  });
  document.getElementById("description-input").addEventListener("input", (e) => {
    edit.description = e.target.value;
  });

  // Keyboard nudges: Enter = save, S = skip. Enter works from inside the
  // name input too — finishing the name and pressing Enter is the natural
  // "done with this flag" gesture. Inside the description textarea, Enter
  // inserts a newline (Ctrl/Cmd+Enter still saves so the curator has a
  // keyboard exit). 's' only fires when no text field is focused so typing
  // the letter into a name or description doesn't skip.
  document.addEventListener("keydown", (e) => {
    const inText = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
    if (e.key === "Enter") {
      if (e.target.tagName === "TEXTAREA" && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      handleSave();
    } else if (e.key.toLowerCase() === "s" && !inText) {
      e.preventDefault();
      handleSkip();
    }
  });
}

main();
