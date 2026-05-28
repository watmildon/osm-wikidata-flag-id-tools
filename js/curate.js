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
  text: "Text", animal: "Animal", people: "People", star: "Star",
  cross: "Cross", stripes: "Stripes", circle: "Circle",
  crescent: "Crescent", coa: "Coat of arms",
};
const SHAPE_LABELS = {
  "1:2": "1:2", "2:3": "2:3", "3:5": "3:5",
  square: "Square", pennant: "Pennant", other: "Other", unknown: "Unknown",
};

// ---- state ----

let meta = null;          // full flags.json
let queue = [];           // ordered list of flag records to work through
let queueIndex = 0;
let edit = null;          // { colors:Set, icons:Set, shape:string|null } for current flag
let pending = loadPending(); // { qid: {colors, icons, shape} }

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
  return (e.colors?.length ?? 0) === 0
      || (e.icons?.length ?? 0) === 0
      || !e.shape || e.shape === "unknown";
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
    edit = { colors: new Set(), icons: new Set(), shape: null };
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

  edit = {
    colors: new Set(e.colors ?? []),
    icons: new Set(e.icons ?? []),
    shape: e.shape && e.shape !== "unknown" ? e.shape : null,
  };
  renderChips();
}

// ---- actions ----

function commitCurrent() {
  if (queue.length === 0) return;
  const f = queue[queueIndex];
  // Only persist fields the user actually chose. If the user cleared
  // everything, drop the pending entry entirely.
  const entry = {};
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

async function handleExport() {
  // Fetch the current overrides.json from the repo (committed state) and
  // merge our pending edits on top. Output preserves any keys the curator
  // didn't touch this session.
  let base = {};
  try {
    const res = await fetch("data/overrides.json");
    if (res.ok) base = await res.json();
  } catch {
    // Fine — there may be no overrides yet.
  }
  const merged = { ...base, ...pending };
  // Sort keys for stable diffs.
  const sorted = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];

  const blob = new Blob([JSON.stringify(sorted, null, 2) + "\n"], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "overrides.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${Object.keys(pending).length} edits — save into data/overrides.json`);
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
  buildQueue();
  renderCurrent();
  updatePendingUI();

  document.getElementById("save-btn").addEventListener("click", handleSave);
  document.getElementById("skip-btn").addEventListener("click", handleSkip);
  document.getElementById("export-btn").addEventListener("click", handleExport);
  document.getElementById("clear-pending-btn").addEventListener("click", handleClearPending);
  document.getElementById("only-needs-attention").addEventListener("change", handleFilterChange);
  document.getElementById("hide-non-flag-entities").addEventListener("change", handleFilterChange);

  // Keyboard nudges: Enter = save, S = skip
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    else if (e.key.toLowerCase() === "s") { e.preventDefault(); handleSkip(); }
  });
}

main();
