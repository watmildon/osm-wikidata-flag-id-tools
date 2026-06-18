import { loadFlags } from "./data.js";
import { showToast } from "./clipboard.js";
import { thumbSrc, fullSrc } from "./render.js";
import { attachFlipControl } from "./flip.js";
import {
  initEditing,
  pendingCount,
  effectiveField,
  setField,
  clearPending,
  onPendingChange,
  onReviewReset,
  exportOverrides,
} from "./editing.js";

// ---- constants ----

const RANDOMIZE_STORAGE_KEY = "osm-flag-curate-randomize";

const COLOR_SWATCHES = {
  red: "#dc2626", white: "#ffffff", blue: "#1d4ed8", darkblue: "#1e2a5e",
  lightblue: "#7dd3fc", green: "#16a34a", yellow: "#facc15",
  black: "#111827", orange: "#ea580c", brown: "#92400e", purple: "#7e22ce",
  pink: "#ec4899", gray: "#9ca3af",
};
const ICON_LABELS = {
  text: "Text", animal: "Animal", bird: "Bird", people: "People", plant: "Plant",
  star: "Star", sun: "Sun", cross: "Cross", crescent: "Crescent", circle: "Circle",
  "horizontal-stripes": "Horizontal stripes", "vertical-stripes": "Vertical stripes",
  triangle: "Triangle", diagonal: "Diagonal",
  weapon: "Weapon", map: "Map", building: "Building", coa: "Coat of arms",
  crown: "Crown", tools: "Tools", water: "Water", ship: "Ship",
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
let edit = null;          // { colors:Set, icons:Set, shape:string|null, ... } for current flag

// ---- effective record (uses the shared editing layer) ----

// Read every editable field through the shared editing module so pending,
// committed, and base flag values all layer in the right order.
const EDITABLE_FIELDS = ["flagName", "flagType", "colors", "icons", "shape", "description"];
function effective(f) {
  const e = { ...f };
  for (const field of EDITABLE_FIELDS) {
    const v = effectiveField(f.qid, field);
    if (v !== undefined) e[field] = v;
  }
  return e;
}

// ---- pending UI ----

function updatePendingUI() {
  const n = pendingCount();
  document.getElementById("pending-count").textContent = n;
  document.getElementById("export-btn").disabled = n === 0;
  document.getElementById("clear-pending-btn").disabled = n === 0;
}

// ---- needs-attention chip set ----

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
  const randomize = document.getElementById("randomize-queue").checked;
  // flags.json is sorted by qid on disk for clean diffs. We re-sort here:
  // randomize when on (default) so concurrent curators land on different
  // flags; otherwise count desc so a solo curator works highest-impact first.
  queue = meta.flags
    .filter((f) => (!hideNonFlag || f.isFlagEntity))
    .filter(needsAttention);
  if (randomize) {
    // Fisher-Yates. Shuffled once per build, not per advance, so position
    // counters mean something and skipped flags don't reappear.
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  } else {
    queue.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  }
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

// Drop any flip control left over from the previously-shown flag. The image
// and its wrapper persist across renders (unlike the virtualized list pages),
// so we clear and re-attach the control each time rather than leak handlers.
function clearFlip() {
  const wrap = document.getElementById("flag-img-wrap");
  wrap.querySelector(".badge-flip")?.remove();
}

function renderCurrent() {
  if (queue.length === 0) {
    document.getElementById("flag-name").textContent = "Queue empty";
    document.getElementById("queue-pos").textContent = "0 of 0";
    document.getElementById("flag-img").src = "flags/placeholder.svg";
    document.getElementById("flag-img").alt = "";
    clearFlip();
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
  const flagImg = document.getElementById("flag-img");
  flagImg.src = fullSrc(f);
  flagImg.alt = `Flag: ${f.name}`;
  clearFlip();
  attachFlipControl(document.getElementById("flag-img-wrap"), flagImg, f, fullSrc);
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

// Commit the current in-progress edit into the shared editing layer. Per
// field: trim/normalize the value, then call setField — which itself
// performs the no-op check against the baseline and either records or
// discards the change.
function commitCurrent() {
  if (queue.length === 0) return;
  const f = queue[queueIndex];
  // Read input values live (the `input` events keep edit.* in sync, but be
  // defensive in case of unfocused-input edge cases).
  edit.flagName = document.getElementById("name-input").value.trim();
  edit.description = document.getElementById("description-input").value.trim();
  // flagName / description: empty string means "no override" → omit.
  setField(f.qid, "flagName", edit.flagName || undefined);
  setField(f.qid, "description", edit.description || undefined);
  setField(f.qid, "flagType", edit.flagType || undefined);
  setField(f.qid, "shape", edit.shape || undefined);
  setField(f.qid, "colors", edit.colors.size ? [...edit.colors] : undefined);
  setField(f.qid, "icons", edit.icons.size ? [...edit.icons] : undefined);
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

async function handleExport() {
  const beforeCount = pendingCount();
  const { method } = await exportOverrides();
  if (method === "direct") {
    showToast(`Saved ${beforeCount} edits to overrides.json`);
  } else {
    showToast(`Downloaded ${beforeCount} edits — save into data/overrides.json`);
  }
}

function handleClearPending() {
  if (!confirm(`Discard ${pendingCount()} unsaved edits?`)) return;
  clearPending();
  showToast("Pending edits cleared");
  // Counts may shift back up as in-session work disappears.
  renderNeedsChips();
  buildQueue();
  renderCurrent();
}

function handleFilterChange() {
  buildQueue();
  renderCurrent();
}

// ---- boot ----

async function main() {
  meta = await loadFlags();

  // Initialize the shared editing layer. This loads the committed
  // overrides.json, migrates any per-page legacy pending bags into the new
  // shared key, and smart-prunes pending fields that already match the
  // committed (or original) baseline.
  const { prunedCount } = await initEditing(meta.flags);
  if (prunedCount > 0) {
    showToast(`Cleared ${prunedCount} edit${prunedCount === 1 ? "" : "s"} already in overrides.json`);
  }

  // Re-render counts and the queue whenever the pending bag changes — that
  // includes chip clicks here AND saves from any other tab/page that
  // touches the same localStorage key.
  onPendingChange(() => {
    updatePendingUI();
  });

  // Surface "your edit cleared prior reviewers' approval of this field".
  // Curate commits all fields at Save, so multiple resets can fire in a
  // single click; show them as separate toasts but coalesced by field name
  // (Save All would otherwise dispatch e.g. "cleared 3 colors reviews"
  // and "cleared 2 icons reviews" back-to-back, which is informative).
  onReviewReset(({ field, prevCount }) => {
    showToast(
      `Cleared ${prevCount} prior ${field} review${prevCount === 1 ? "" : "s"} — value changed`,
      2500,
    );
  });

  renderNeedsChips();

  // Restore randomize preference from prior session BEFORE the first
  // buildQueue() reads its state. Default (HTML attr) is checked=true.
  const randomizeBox = document.getElementById("randomize-queue");
  const storedRandomize = localStorage.getItem(RANDOMIZE_STORAGE_KEY);
  if (storedRandomize !== null) randomizeBox.checked = storedRandomize === "1";

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
  randomizeBox.addEventListener("change", () => {
    localStorage.setItem(RANDOMIZE_STORAGE_KEY, randomizeBox.checked ? "1" : "0");
    handleFilterChange();
  });

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
