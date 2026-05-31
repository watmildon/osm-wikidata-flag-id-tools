function overpassTurboUrl(badQid) {
  // Query that finds every OSM element where flag:wikidata exactly equals the
  // bad QID. Mappers can open this in overpass-turbo, see the elements on a
  // map, edit them, and save.
  const query = `[out:json][timeout:60];
nwr["flag:wikidata"="${badQid}"];
out center meta;`;
  return `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}&R`;
}

// Same inline-SVG convention used on the wikidata-suggestions page. Map-pin
// shape signals "find on a map", which is what overpass-turbo opens to.
const ICON_MAP_PIN =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 14s5-4.5 5-8.5a5 5 0 0 0-10 0C3 9.5 8 14 8 14z"/>' +
  '<circle cx="8" cy="5.5" r="1.75"/></svg>';

function wdUrl(qid) {
  return `https://www.wikidata.org/wiki/${qid}`;
}

function thumbUrl(qid) {
  // The suggested flag's thumbnail — built sites have it; falls back if missing.
  return `flags/thumb/${qid}.png`;
}

function row(s) {
  const tr = document.createElement("tr");

  // Bad QID column: QID link + entity label + reason tag
  const badCell = document.createElement("td");
  const badLink = document.createElement("a");
  badLink.href = wdUrl(s.bad_qid);
  badLink.target = "_blank";
  badLink.rel = "noopener";
  badLink.textContent = s.bad_qid;
  badCell.appendChild(badLink);
  if (s.reason === "redirect") {
    badCell.appendChild(document.createTextNode(" "));
    const tag = document.createElement("span");
    tag.className = "reason-tag";
    tag.textContent = "redirect";
    badCell.appendChild(tag);
  }
  badCell.appendChild(document.createElement("br"));
  const badName = document.createElement("span");
  badName.className = "muted";
  badName.textContent = s.bad_name;
  badCell.appendChild(badName);
  tr.appendChild(badCell);

  // Suggested column: thumbnail + QID link + label
  const sugCell = document.createElement("td");
  sugCell.className = "suggested-cell";
  const sugImg = document.createElement("img");
  sugImg.src = thumbUrl(s.suggested_qid);
  sugImg.alt = "";
  sugImg.loading = "lazy";
  sugImg.className = "review-thumb";
  sugImg.onerror = () => { sugImg.src = "flags/placeholder.svg"; };
  sugCell.appendChild(sugImg);
  const sugText = document.createElement("div");
  const sugLink = document.createElement("a");
  sugLink.href = wdUrl(s.suggested_qid);
  sugLink.target = "_blank";
  sugLink.rel = "noopener";
  sugLink.textContent = s.suggested_qid;
  sugText.appendChild(sugLink);
  if (s.target_is_stub) {
    sugText.appendChild(document.createTextNode(" "));
    const stub = document.createElement("span");
    stub.className = "reason-tag";
    stub.textContent = "stub";
    stub.title = "The suggested flag entity itself needs Wikidata cleanup " +
      "(missing P31/P279* flag classification or P18 image). Switching the " +
      "OSM tag is still an improvement; the Wikidata cleanup is a separate task.";
    sugText.appendChild(stub);
  }
  sugText.appendChild(document.createElement("br"));
  const sugName = document.createElement("span");
  sugName.className = "muted";
  sugName.textContent = s.suggested_name;
  sugText.appendChild(sugName);
  sugCell.appendChild(sugText);
  tr.appendChild(sugCell);

  // Count
  const cntCell = document.createElement("td");
  cntCell.className = "num";
  cntCell.textContent = s.count.toLocaleString();
  tr.appendChild(cntCell);

  // Overpass-turbo link — icon button matching the convention used on the
  // wikidata-suggestions page (cell stays a table-cell so it aligns to the
  // row baseline; flex layout lives on the inner wrapper).
  const otCell = document.createElement("td");
  otCell.className = "fix-actions";
  const otInner = document.createElement("div");
  otInner.className = "fix-actions-inner";
  const otLink = document.createElement("a");
  otLink.href = overpassTurboUrl(s.bad_qid);
  otLink.target = "_blank";
  otLink.rel = "noopener";
  otLink.className = "icon-btn";
  otLink.title = "Open in overpass-turbo";
  otLink.setAttribute("aria-label", "Open in overpass-turbo");
  otLink.innerHTML = ICON_MAP_PIN;
  otInner.appendChild(otLink);
  otCell.appendChild(otInner);
  tr.appendChild(otCell);

  return tr;
}

async function main() {
  let data;
  try {
    const res = await fetch("data/review.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    document.getElementById("review-count").textContent =
      "Couldn't load review.json — run `npm run build:review` first.";
    console.error(e);
    return;
  }

  // review.json is sorted by bad_qid on disk for clean diffs; sort by count
  // desc here so the most-impactful mistakes show first.
  const suggestions = [...data.suggestions].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const tbody = document.getElementById("review-rows");
  for (const s of suggestions) {
    tbody.appendChild(row(s));
  }
  const total = suggestions.reduce((n, s) => n + s.count, 0);
  document.getElementById("review-count").textContent =
    `${suggestions.length} suggested fixes covering ${total.toLocaleString()} OSM elements.`;
}

main();
