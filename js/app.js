import { loadFlags } from "./data.js";
import { subscribe, matches, activeCount, clear } from "./filters.js";
import { renderFilters, renderGrid, updateFilterSummary, fullSrc } from "./render.js";
import { copyTags, tagsFor, showToast } from "./clipboard.js";

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
  wd.textContent = `View ${flag.qid} on Wikidata ↗`;
  const src = document.getElementById("detail-source");
  if (flag.flagType && typeof flag.flagTypeSample === "number") {
    src.textContent = `flag:type inferred from ${flag.flagTypeSample.toLocaleString()} OSM uses`;
  } else if (flag.flagType) {
    src.textContent = `flag:type set from Name Suggestion Index or override`;
  } else if (flag.count) {
    src.textContent = `flag:type not inferred — set it yourself based on context`;
  } else {
    src.textContent = "";
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
  allFlags = meta.flags;

  renderFilters(meta);
  applyFilters();

  subscribe(() => {
    renderFilters(meta);
    applyFilters();
  });

  document.getElementById("clear-btn").addEventListener("click", clear);
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("detail-copy").addEventListener("click", handleCopy);
  document.getElementById("detail").addEventListener("click", (e) => {
    if (e.target.id === "detail") closeDetail();
  });
}

main();
