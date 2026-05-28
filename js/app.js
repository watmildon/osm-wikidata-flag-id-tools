import { loadFlags } from "./data.js";
import { subscribe, matches, activeCount, clear, setQuery } from "./filters.js";
import { renderFilters, renderGrid, updateFilterSummary, fullSrc } from "./render.js";
import { copyTags, tagsFor, showToast } from "./clipboard.js";

// Inline SVG icons for the detail dialog's action buttons. Matches the
// convention used on wikidata-suggestions / review pages so the visual
// vocabulary is consistent across the site.
const ICON_WIKIDATA =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10"/>' +
  '<path d="M9 2h5v5"/><path d="M14 2 7 9"/></svg>';
const ICON_MAP_PIN =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 14s5-4.5 5-8.5a5 5 0 0 0-10 0C3 9.5 8 14 8 14z"/>' +
  '<circle cx="8" cy="5.5" r="1.75"/></svg>';
const ICON_PENCIL =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m11 2 3 3-8 8H3v-3z"/></svg>';

function overpassTurboUrl(qid) {
  const query = `[out:json][timeout:60];
nwr["flag:wikidata"="${qid}"];
out center meta;`;
  return `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}&R`;
}

let allFlags = [];
let currentFlag = null;

function applyFilters() {
  const filtered = allFlags.filter(matches);
  renderGrid(filtered, openDetail);
  updateFilterSummary(activeCount());
}

function openDetail(flag) {
  currentFlag = flag;
  document.getElementById("detail-img").src = fullSrc(flag);
  document.getElementById("detail-img").alt = `Flag of ${flag.name}`;
  document.getElementById("detail-name").textContent = flag.name;
  document.getElementById("detail-tags").textContent = tagsFor(flag);
  const wd = document.getElementById("detail-wikidata");
  wd.href = `https://www.wikidata.org/wiki/${flag.qid}`;
  wd.title = `View ${flag.qid} on Wikidata`;
  wd.setAttribute("aria-label", wd.title);
  wd.innerHTML = ICON_WIKIDATA;
  const overpass = document.getElementById("detail-overpass");
  overpass.href = overpassTurboUrl(flag.qid);
  overpass.innerHTML = ICON_MAP_PIN;
  const curate = document.getElementById("detail-curate");
  curate.href = `curate.html?qid=${flag.qid}`;
  curate.innerHTML = ICON_PENCIL;
  const src = document.getElementById("detail-source");
  if (flag.flagType && typeof flag.flagTypeSample === "number") {
    src.textContent = `flag:type inferred from ${flag.flagTypeSample.toLocaleString()} OSM uses`;
  } else if (flag.flagType) {
    src.textContent = `flag:type set from Name Suggestion Index or override`;
  } else if (flag.count) {
    src.textContent = `flag:type not inferred — set it yourself based on context`;
  } else {
    src.textContent = `not yet tagged on OSM — be the first to add it`;
  }
  const dlg = document.getElementById("detail");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeDetail() {
  const dlg = document.getElementById("detail");
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
  currentFlag = null;
}

async function handleCopy() {
  if (!currentFlag) return;
  const { ok } = await copyTags(currentFlag);
  if (ok) {
    showToast(`Copied tags for ${currentFlag.name}`);
    closeDetail();
  } else {
    showToast("Copy blocked — long-press the tags above to select");
  }
}

async function main() {
  let meta;
  try {
    meta = await loadFlags();
  } catch (e) {
    document.getElementById("count").textContent =
      "Failed to load flags.json — run `npm run build` first.";
    console.error(e);
    return;
  }
  // flags.json is sorted by qid on disk for clean diffs; sort by count
  // descending in memory so the most-mapped flags appear first in the grid.
  allFlags = [...meta.flags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  renderFilters(meta);
  applyFilters();

  subscribe(() => {
    renderFilters(meta);
    applyFilters();
  });

  const searchInput = document.getElementById("search-input");
  let searchTimer = null;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => setQuery(v), 120);
  });

  document.getElementById("clear-btn").addEventListener("click", () => {
    searchInput.value = "";
    clear();
  });
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("detail-copy").addEventListener("click", handleCopy);
  document.getElementById("detail").addEventListener("click", (e) => {
    if (e.target.id === "detail") closeDetail();
  });
}

main();
