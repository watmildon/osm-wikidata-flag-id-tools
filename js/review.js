function overpassTurboUrl(badQid) {
  // Query that finds every OSM element where flag:wikidata exactly equals the
  // bad QID. Mappers can open this in overpass-turbo, see the elements on a
  // map, edit them, and save.
  const query = `[out:json][timeout:60];
nwr["flag:wikidata"="${badQid}"];
out center meta;`;
  return `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}&R`;
}

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

  // Overpass-turbo link
  const otCell = document.createElement("td");
  const otLink = document.createElement("a");
  otLink.href = overpassTurboUrl(s.bad_qid);
  otLink.target = "_blank";
  otLink.rel = "noopener";
  otLink.className = "ot-link";
  otLink.textContent = "Open in overpass-turbo ↗";
  otCell.appendChild(otLink);
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
