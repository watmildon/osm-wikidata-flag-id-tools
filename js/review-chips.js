// Shared logic for review-colors.html and review-icons.html. Each page
// loads this module and passes a config that says: which field am I
// editing, which set of values is valid, and how do I render each chip.
//
// The page itself is just chrome (filter bar + virtualized list + toolbar);
// this module wires the data and behavior to the DOM ids the page exposes.

import {
  initEditing,
  pendingCount,
  effectiveField,
  isEdited,
  setField,
  clearPending,
  onPendingChange,
  exportOverrides,
  reviewCount,
  reviewedHere,
  toggleReview,
  onReviewReset,
} from "./editing.js";

const BUFFER_ROWS = 4;

// ---- helpers reused across review pages ----

const FLAG_FILENAME_RE = /^(flag|bandera|bandiera|drapeau|vlag|bandeira|flagga|flagge|flaga|fahne|byrak|zastava|prapor|drapelul)/i;
const WONKY_FILENAME_RE = /headquarter|\bview\b|entrance|stadium|\bpark\b|street|\bcenter\b|building|\bhotel\b|\bstore\b|\bstation\b|\bhall\b|library|fountain|harbor|\btower\b|hospital|circuit|college|university|plaza|airport|riverside|montage|skyline|panorama|aerial|location[ -]?map|orthographic|locator|collage|cathedral|church|castle|courthouse|capitol/i;

function imageFilename(flag) {
  if (flag.imageWithheld) return null;
  return flag.localFile || flag.file || null;
}
function looksLikeFlagFilename(filename) {
  if (!filename) return false;
  if (filename.toLowerCase().endsWith(".svg")) return true;
  return FLAG_FILENAME_RE.test(filename);
}
function looksWonkyFilename(filename) {
  if (!filename) return false;
  if (looksLikeFlagFilename(filename)) return false;
  if (WONKY_FILENAME_RE.test(filename.toLowerCase())) return true;
  if (/\.(jpe?g|tiff?)$/i.test(filename)) return true;
  return false;
}

function thumbSrc(flag) {
  if (flag.imageWithheld) return "flags/placeholder.svg";
  if (flag.localFile) return `flags/local/${flag.localFile}`;
  if (!flag.file) return "flags/placeholder.svg";
  return `flags/full/${flag.qid}.png`;
}

function qidNum(qid) { return parseInt(qid.slice(1), 10); }

function showToast(msg, ms = 1800) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

// ---- main mounter ----

// Config shape:
//   {
//     field: "colors" | "icons",        // which override field this page edits
//     values: ["red", "white", ...],    // the full vocabulary (chip set)
//     chipLabel: (v) => "Red",          // chip text
//     chipSwatch?: (v) => "#dc2626",    // optional swatch color for color chips
//     emptyLabel: "Missing colors",     // text for the "row has no value" badge
//   }
export async function mountReviewChips(config) {
  // ---- state ----
  let allFlags = [];
  let visibleFlags = [];
  let rowHeight = 0;

  // Filter defaults. The search box is intentionally NOT persisted — it
  // feels like transient lookup state, not an ongoing preference.
  // Everything else is persisted in localStorage keyed by config.field so
  // review-colors and review-icons remember their settings independently.
  const FILTER_STORAGE_KEY = `osm-flag-filters-review-${config.field}`;
  const FILTER_DEFAULTS = {
    emptyOnly: false,
    unreviewedOnly: false,
    hasImageOnly: true,
    flagEntityOnly: true,
    hideWonky: true,
    sort: "count-desc",
  };
  function loadFilterPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? "null");
      if (raw && typeof raw === "object") {
        // Spread defaults first so any new filter added since the user last
        // saved gets its default value rather than being undefined.
        return { ...FILTER_DEFAULTS, ...raw };
      }
    } catch {}
    return { ...FILTER_DEFAULTS };
  }
  function saveFilterPrefs() {
    const { search: _omit, ...persisted } = filters;
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(persisted)); }
    catch {}
  }
  const filters = { search: "", ...loadFilterPrefs() };

  function effective(flag) {
    const v = effectiveField(flag.qid, config.field);
    return Array.isArray(v) ? v : [];
  }

  function applyFilters() {
    const q = filters.search.trim().toLowerCase();
    let list = allFlags.filter((f) => {
      if (filters.hasImageOnly && !f.file && !f.localFile) return false;
      if (filters.emptyOnly && effective(f).length > 0) return false;
      if (filters.unreviewedOnly && reviewCount(f.qid, config.field) > 0) return false;
      if (filters.flagEntityOnly && !f.isFlagEntity) return false;
      if (filters.hideWonky && looksWonkyFilename(imageFilename(f))) return false;
      if (q) {
        const hay = (f.name + " " + (f.flagName ?? "") + " " + (f.description ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    switch (filters.sort) {
      case "count-desc": list.sort((a, b) => (b.count ?? 0) - (a.count ?? 0)); break;
      case "count-asc":  list.sort((a, b) => (a.count ?? 0) - (b.count ?? 0)); break;
      case "reviews-asc":
        // Tiebreak by OSM count desc so among equally-unreviewed flags, the
        // most-mapped ones still rise to the top.
        list.sort((a, b) => {
          const diff = reviewCount(a.qid, config.field) - reviewCount(b.qid, config.field);
          if (diff !== 0) return diff;
          return (b.count ?? 0) - (a.count ?? 0);
        });
        break;
      case "name-asc":   list.sort((a, b) => (a.flagName ?? a.name).localeCompare(b.flagName ?? b.name)); break;
      case "qid-asc":    list.sort((a, b) => qidNum(a.qid) - qidNum(b.qid)); break;
    }
    visibleFlags = list;
    document.getElementById("visible-count").textContent =
      `${visibleFlags.length.toLocaleString()} of ${allFlags.length.toLocaleString()} shown`;
    const emptyEl = document.getElementById("empty");
    const outerEl = document.getElementById("vlist-outer");
    if (visibleFlags.length === 0) {
      emptyEl.hidden = false;
      outerEl.style.height = "0px";
    } else {
      emptyEl.hidden = true;
      outerEl.style.height = (visibleFlags.length * rowHeight) + "px";
    }
    renderWindow(true);
  }

  function buildRow(flag) {
    const current = effective(flag);
    const selected = new Set(current);

    const row = document.createElement("section");
    row.className = "review-row";
    row.dataset.qid = flag.qid;
    if (isEdited(flag.qid, config.field)) row.classList.add("edited");
    if (current.length === 0) row.classList.add("empty");

    const imgCell = document.createElement("div");
    imgCell.className = "img-cell";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Flag of ${flag.name}`;
    img.src = thumbSrc(flag);
    img.onerror = () => { img.src = "flags/placeholder.svg"; };
    imgCell.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "meta";

    const h = document.createElement("h3");
    h.appendChild(document.createTextNode(flag.flagName ?? flag.name));
    const editedTag = document.createElement("span");
    editedTag.className = "edited-tag";
    editedTag.textContent = "Edited";
    h.appendChild(editedTag);
    const emptyTag = document.createElement("span");
    emptyTag.className = "empty-tag";
    emptyTag.textContent = config.emptyLabel;
    h.appendChild(emptyTag);
    // Review-count badge. Always rendered so the layout doesn't shift when
    // the count changes from 0 → 1 mid-session.
    const reviewBadge = document.createElement("span");
    reviewBadge.className = "review-badge";
    function paintReviewBadge() {
      const n = reviewCount(flag.qid, config.field);
      reviewBadge.textContent = n === 0 ? "0 reviews" : `${n} review${n === 1 ? "" : "s"}`;
      reviewBadge.classList.toggle("zero", n === 0);
    }
    paintReviewBadge();
    h.appendChild(reviewBadge);
    meta.appendChild(h);

    const line = document.createElement("p");
    line.className = "line";
    const a = document.createElement("a");
    a.href = `https://www.wikidata.org/wiki/${flag.qid}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = flag.qid;
    line.appendChild(a);
    line.append(` · ${(flag.count ?? 0).toLocaleString()} OSM uses`);
    if (flag.flagType) line.append(` · ${flag.flagType}`);
    meta.appendChild(line);

    const chipsRow = document.createElement("div");
    chipsRow.className = "row-chips";
    for (const v of config.values) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row-chip";
      btn.setAttribute("aria-pressed", String(selected.has(v)));
      if (config.chipSwatch) {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = config.chipSwatch(v);
        btn.appendChild(sw);
      }
      const text = document.createElement("span");
      text.textContent = config.chipLabel(v);
      btn.appendChild(text);
      btn.addEventListener("click", () => {
        if (selected.has(v)) selected.delete(v);
        else selected.add(v);
        btn.setAttribute("aria-pressed", String(selected.has(v)));
        // Persist into the shared editing layer. Empty set → undefined so
        // setField drops the override (clearing colors means "use the
        // baseline value", which is usually [] anyway but we don't want a
        // pending [] sitting around).
        const arr = [...selected];
        setField(flag.qid, config.field, arr.length === 0 ? undefined : arr);
        if (isEdited(flag.qid, config.field)) row.classList.add("edited");
        else row.classList.remove("edited");
        if (selected.size === 0) row.classList.add("empty");
        else row.classList.remove("empty");
      });
      chipsRow.appendChild(btn);
    }
    meta.appendChild(chipsRow);

    // "Looks good" button → toggles the review counter for this browser.
    // First click increments, second click undoes (useful if the user
    // clicked by mistake). Different browsers count as different
    // reviewers, so each can independently +1 / undo.
    const actionRow = document.createElement("div");
    actionRow.className = "row-actions";
    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "review-btn";
    function paintReviewBtn() {
      if (reviewedHere(flag.qid, config.field)) {
        reviewBtn.textContent = "✓ Reviewed (click to undo)";
        reviewBtn.classList.add("reviewed");
      } else {
        reviewBtn.textContent = "Looks good";
        reviewBtn.classList.remove("reviewed");
      }
    }
    paintReviewBtn();
    reviewBtn.addEventListener("click", () => {
      toggleReview(flag.qid, config.field);
      paintReviewBadge();
      paintReviewBtn();
    });
    actionRow.appendChild(reviewBtn);
    meta.appendChild(actionRow);

    row.appendChild(imgCell);
    row.appendChild(meta);
    return row;
  }

  let lastStart = -1, lastEnd = -1;
  function renderWindow(force) {
    if (visibleFlags.length === 0) {
      document.getElementById("vlist-inner").innerHTML = "";
      return;
    }
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const viewportH = window.innerHeight;
    const outerTop = document.getElementById("vlist-outer").offsetTop;
    const relTop = Math.max(0, scrollTop - outerTop);
    const startIdx = Math.max(0, Math.floor(relTop / rowHeight) - BUFFER_ROWS);
    const endIdx = Math.min(
      visibleFlags.length,
      Math.ceil((relTop + viewportH) / rowHeight) + BUFFER_ROWS,
    );
    if (!force && startIdx === lastStart && endIdx === lastEnd) return;
    lastStart = startIdx;
    lastEnd = endIdx;

    const inner = document.getElementById("vlist-inner");
    inner.style.transform = `translateY(${startIdx * rowHeight}px)`;
    inner.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      frag.appendChild(buildRow(visibleFlags[i]));
    }
    inner.appendChild(frag);
  }

  function updateToolbar() {
    const n = pendingCount();
    const status = document.getElementById("status");
    const exportBtn = document.getElementById("export-btn");
    const resetBtn = document.getElementById("reset-btn");
    status.textContent = n === 0 ? "No edits" : `${n} edit${n === 1 ? "" : "s"} pending`;
    exportBtn.disabled = n === 0;
    resetBtn.disabled = n === 0;
  }

  function measureRowHeight() {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.height = "var(--row-h)";
    probe.style.width = "1px";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    document.body.removeChild(probe);
    return h || 220;
  }

  // ---- boot ----
  let flagsData;
  try {
    const res = await fetch("data/flags.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    flagsData = await res.json();
  } catch (err) {
    document.getElementById("status").textContent = `Failed to load flags.json: ${err.message}`;
    return;
  }
  allFlags = flagsData.flags ?? [];
  rowHeight = measureRowHeight();

  const { prunedCount } = await initEditing(allFlags);
  if (prunedCount > 0) {
    setTimeout(() => showToast(
      `Cleared ${prunedCount} edit${prunedCount === 1 ? "" : "s"} already in overrides.json`,
      3000,
    ), 100);
  }

  onPendingChange(updateToolbar);

  // Surface "we just reset prior reviews because the value changed". The
  // setField in this page only ever changes the page's primary field
  // (colors or icons), so we don't need to disambiguate which field —
  // it's always config.field. Re-render the visible window so the badge
  // and button paint the new (zero) state immediately.
  onReviewReset(({ prevCount }) => {
    showToast(
      `Cleared ${prevCount} prior review${prevCount === 1 ? "" : "s"} — value changed`,
      2500,
    );
    renderWindow(true);
  });

  // Filter wiring. Each control writes back to `filters`, persists the
  // (non-search) state, and triggers a refresh from the top.
  const searchInput = document.getElementById("search-input");
  let searchTimer = null;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      filters.search = v;
      window.scrollTo({ top: 0 });
      applyFilters();
    }, 120);
  });
  // Sync the DOM controls to the (possibly persisted) filter state, THEN
  // wire change handlers. Without the sync the checkboxes would show
  // their HTML-default state while the filter logic uses the loaded one.
  const checkboxFilters = [
    ["filter-empty",           "emptyOnly"],
    ["filter-unreviewed",      "unreviewedOnly"],
    ["filter-has-image",       "hasImageOnly"],
    ["filter-is-flag-entity",  "flagEntityOnly"],
    ["filter-hide-wonky",      "hideWonky"],
  ];
  for (const [id, key] of checkboxFilters) {
    const el = document.getElementById(id);
    el.checked = Boolean(filters[key]);
    el.addEventListener("change", (e) => {
      filters[key] = e.target.checked;
      saveFilterPrefs();
      window.scrollTo({ top: 0 });
      applyFilters();
    });
  }
  const sortEl = document.getElementById("sort-select");
  sortEl.value = filters.sort;
  sortEl.addEventListener("change", (e) => {
    filters.sort = e.target.value;
    saveFilterPrefs();
    window.scrollTo({ top: 0 });
    applyFilters();
  });

  let rafPending = false;
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderWindow(false);
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    rowHeight = measureRowHeight();
    applyFilters();
  });

  document.getElementById("export-btn").addEventListener("click", async () => {
    const n = pendingCount();
    const { method } = await exportOverrides();
    if (method === "direct") {
      showToast(`Saved ${n} edits to overrides.json`);
    } else {
      showToast(`Downloaded ${n} edits — save into data/overrides.json`);
    }
  });
  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("Discard all pending edits?")) return;
    clearPending();
    location.reload();
  });

  applyFilters();
  updateToolbar();
}
