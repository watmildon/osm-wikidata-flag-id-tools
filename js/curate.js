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
  weapon: "Weapon", map: "Map", coa: "Coat of arms",
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

// Effective record = base flag merged with any pending edit; lets us know if
// the user already curated this flag during the current session.
function effective(f) {
  const p = pending[f.qid];
  return p ? { ...f, ...p } : f;
}

function needsAttention(f) {
  const e = effective(f);
  return (e.colors?.length ?? 0) === 0 || (e.icons?.length ?? 0) === 0;
}

function buildQueue() {
  const needsOnly = document.getElementById("only-needs-attention").checked;
  const hideNonFlag = document.getElementById("hide-non-flag-entities").checked;
  queue = meta.flags
    .filter((f) => (!hideNonFlag || f.isFlagEntity))
    .filter((f) => (!needsOnly || needsAttention(f)));
  // Already sorted by count desc in flags.json; preserve that order.
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
    document.getElementById("flag-description").textContent = "";
    document.getElementById("name-input").value = "";
    edit = { flagName: "", flagType: null, colors: new Set(), icons: new Set(), shape: null };
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
  const descEl = document.getElementById("flag-description");
  descEl.textContent = e.description ?? "";
  descEl.classList.toggle("is-empty", !e.description);

  const nameInput = document.getElementById("name-input");
  nameInput.value = e.flagName ?? "";
  nameInput.placeholder = f.flagName ?? f.name;

  edit = {
    flagName: e.flagName ?? "",
    flagType: e.flagType ?? null,
    colors: new Set(e.colors ?? []),
    icons: new Set(e.icons ?? []),
    shape: e.shape ?? null,
  };
  renderChips();
}

// ---- actions ----

function commitCurrent() {
  if (queue.length === 0) return;
  const f = queue[queueIndex];
  // Snapshot the curator's intent into a sparse override. A field is written
  // only when it differs from the effective value already on the record —
  // otherwise we'd freeze whatever NSI/Overpass gave us as a manual override.
  // Read input value live (the `input` event keeps edit.flagName in sync, but
  // be defensive in case of unfocused-input edge cases).
  edit.flagName = document.getElementById("name-input").value.trim();
  const entry = {};
  if (edit.flagName && edit.flagName !== (f.flagName ?? "")) {
    entry.flagName = edit.flagName;
  }
  if (edit.flagType && edit.flagType !== (f.flagType ?? null)) {
    entry.flagType = edit.flagType;
  }
  if (edit.colors.size) entry.colors = [...edit.colors];
  if (edit.icons.size) entry.icons = [...edit.icons];
  if (edit.shape) entry.shape = edit.shape;
  if (Object.keys(entry).length === 0) delete pending[f.qid];
  else pending[f.qid] = entry;
  savePending();
}

function advance() {
  if (queueIndex + 1 < queue.length) queueIndex++;
  else queueIndex = queue.length; // signal "past the end"
  renderCurrent();
}

function handleSave() {
  commitCurrent();
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
  const base = await fetchCommittedOverrides();
  const merged = { ...base, ...pending };
  const sorted = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
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

  // Smart prune: if any pending edits are already byte-identical to what's
  // committed in overrides.json (curator saved last session, replaced the
  // file, came back), drop them. Saves the curator from re-saving and from
  // accidentally clobbering future legitimate changes.
  if (Object.keys(pending).length > 0) {
    const committed = await fetchCommittedOverrides();
    const pruned = pruneAlreadyCommitted(committed);
    if (pruned > 0) {
      showToast(`Cleared ${pruned} edit${pruned === 1 ? "" : "s"} already in overrides.json`);
    }
  }

  buildQueue();
  renderCurrent();
  updatePendingUI();

  document.getElementById("save-btn").addEventListener("click", handleSave);
  document.getElementById("skip-btn").addEventListener("click", handleSkip);
  document.getElementById("export-btn").addEventListener("click", handleExport);
  document.getElementById("clear-pending-btn").addEventListener("click", handleClearPending);
  document.getElementById("only-needs-attention").addEventListener("change", handleFilterChange);
  document.getElementById("hide-non-flag-entities").addEventListener("change", handleFilterChange);

  // Keep edit.flagName in sync with the text input as the curator types.
  document.getElementById("name-input").addEventListener("input", (e) => {
    edit.flagName = e.target.value;
  });

  // Keyboard nudges: Enter = save, S = skip. Enter works from inside the
  // name input too — finishing the name and pressing Enter is the natural
  // "done with this flag" gesture. 's' only fires when no input is focused
  // so typing the letter into the name field doesn't skip.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key.toLowerCase() === "s" && e.target.tagName !== "INPUT") {
      e.preventDefault();
      handleSkip();
    }
  });
}

main();
