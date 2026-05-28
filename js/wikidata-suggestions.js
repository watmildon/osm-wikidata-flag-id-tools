// Aggregates the dataset's Wikidata-quality signals into one consolidated
// view. Sections:
//   1. "Not classified as a flag" — non-flag-qids.json minus the entries
//      already covered by review.json's P163 suggestions (those live on
//      review.html since they're an OSM-side fix). Fix: add P31 on Wikidata.
//   2. "Missing image" — flags.json records where file===null. Fix: add P18
//      on Wikidata.
//   3. "Colors" — diff between flags.json `wdColors` (raw from P462) and
//      `colors` (curated, post-override). Three sub-buckets.

// Mirror render.js's swatch palette. Kept in sync by hand because a shared
// module would couple two otherwise-independent entry points.
const COLOR_SWATCHES = {
  red: "#dc2626", white: "#ffffff", blue: "#1d4ed8", green: "#16a34a",
  yellow: "#facc15", black: "#111827", orange: "#ea580c",
  lightblue: "#7dd3fc", brown: "#92400e", purple: "#7e22ce",
};

function wdUrl(qid) {
  return `https://www.wikidata.org/wiki/${qid}`;
}

function thumbUrl(qid) {
  return `flags/thumb/${qid}.png`;
}

// Sort by count desc — most-impactful first. Stable for ties.
function byCountDesc(a, b) {
  return (b.count ?? 0) - (a.count ?? 0);
}

// Renders a list of color slugs as inline swatches with the slug name. Returns
// a DocumentFragment so the caller can append directly to a <td>.
function renderSwatches(slugs) {
  const frag = document.createDocumentFragment();
  if (!slugs?.length) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "(none)";
    frag.appendChild(none);
    return frag;
  }
  for (const s of slugs) {
    const chip = document.createElement("span");
    chip.className = "color-swatch-chip";
    const dot = document.createElement("span");
    dot.className = "color-swatch-dot";
    dot.style.background = COLOR_SWATCHES[s] ?? "transparent";
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(s));
    frag.appendChild(chip);
  }
  return frag;
}

// Compact "flag column" cell: thumbnail + QID + label. Reused by every
// section table so the visual rhythm matches.
function flagCell(f) {
  const td = document.createElement("td");
  td.className = "suggested-cell";
  const img = document.createElement("img");
  img.src = thumbUrl(f.qid);
  img.alt = "";
  img.loading = "lazy";
  img.className = "review-thumb";
  img.onerror = () => { img.src = "flags/placeholder.svg"; };
  td.appendChild(img);
  const text = document.createElement("div");
  const link = document.createElement("a");
  link.href = wdUrl(f.qid);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = f.qid;
  text.appendChild(link);
  text.appendChild(document.createElement("br"));
  const name = document.createElement("span");
  name.className = "muted";
  name.textContent = f.flagName ?? f.name;
  text.appendChild(name);
  td.appendChild(text);
  return td;
}

function wdEditCell(qid, label = "Edit on Wikidata ↗") {
  const td = document.createElement("td");
  const a = document.createElement("a");
  a.href = wdUrl(qid);
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "ot-link";
  a.textContent = label;
  td.appendChild(a);
  return td;
}

function numCell(n) {
  const td = document.createElement("td");
  td.className = "num";
  td.textContent = (n ?? 0).toLocaleString();
  return td;
}

// ---- Section 1: not classified as a flag ----

function notFlagRow(rec) {
  const tr = document.createElement("tr");
  // Non-flag records aren't in flags.json so we don't have a thumbnail or
  // flagName; build a minimal QID cell instead of using flagCell().
  const qidCell = document.createElement("td");
  const a = document.createElement("a");
  a.href = wdUrl(rec.qid);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = rec.qid;
  qidCell.appendChild(a);
  qidCell.appendChild(document.createElement("br"));
  const name = document.createElement("span");
  name.className = "muted";
  name.textContent = rec.name;
  qidCell.appendChild(name);
  tr.appendChild(qidCell);
  tr.appendChild(numCell(rec.count));
  tr.appendChild(wdEditCell(rec.qid, "Open on Wikidata ↗"));
  return tr;
}

// ---- Section 2: missing image ----

function noImageRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid, "Add P18 on Wikidata ↗"));
  return tr;
}

// ---- Section 3: colors ----

function colorsWdEmptyRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  const ours = document.createElement("td");
  ours.appendChild(renderSwatches(f.colors));
  tr.appendChild(ours);
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid, "Add P462 on Wikidata ↗"));
  return tr;
}

function colorsMismatchRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  const wd = document.createElement("td");
  wd.appendChild(renderSwatches(f.wdColors));
  tr.appendChild(wd);
  const ours = document.createElement("td");
  ours.appendChild(renderSwatches(f.colors));
  tr.appendChild(ours);
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid));
  return tr;
}

function colorsUnknownRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid, "Add P462 on Wikidata ↗"));
  return tr;
}

// ---- main ----

function fmtTotal(label, items) {
  if (items.length === 0) return "(none)";
  const total = items.reduce((n, r) => n + (r.count ?? 0), 0);
  return `${items.length.toLocaleString()} ${label}, covering ${total.toLocaleString()} OSM uses`;
}

async function main() {
  let review, nonFlag, flagsData;
  try {
    // review.json gives us the set of QIDs already actionable as an OSM-side
    // retag — those live on review.html, not here. We subtract them from the
    // "not classified as a flag" section so this page only shows records
    // where the *Wikidata* entity needs the fix.
    const [r1, r2, r3] = await Promise.all([
      fetch("data/review.json"),
      fetch("data/non-flag-qids.json"),
      fetch("data/flags.json"),
    ]);
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error("data fetch failed");
    review   = await r1.json();
    nonFlag  = await r2.json();
    flagsData = await r3.json();
  } catch (e) {
    console.error(e);
    document.querySelectorAll(".suggestions-blurb").forEach((p) => {
      p.textContent = "Couldn't load data — run `npm run build` first.";
    });
    return;
  }

  const coveredByReview = new Set((review.suggestions ?? []).map((s) => s.bad_qid));

  // Section 1: non-flag QIDs that DON'T have a P163 suggestion. Those are the
  // ones Wikidata itself needs a P31 edit on; P163 cases are an OSM retag.
  const notFlagOnly = nonFlag
    .filter((r) => !coveredByReview.has(r.qid))
    .sort(byCountDesc);

  // Section 2: flag records without a P18 image.
  const noImage = flagsData.flags
    .filter((f) => !f.file)
    .sort(byCountDesc);

  // Section 3: color disagreements between Wikidata (wdColors) and us
  // (colors, which is wdColors plus any override). Three buckets:
  //   a) WD empty, we have some — straightforward "add P462 on Wikidata".
  //   b) Both populated but lengths differ — review which side is right.
  //   c) Neither has colors — long-tail unclassified.
  const wdEmpty = [];
  const mismatch = [];
  const unknown = [];
  for (const f of flagsData.flags) {
    const w = f.wdColors?.length ?? 0;
    const c = f.colors?.length ?? 0;
    if (w === 0 && c > 0) wdEmpty.push(f);
    else if (w > 0 && c > 0 && w !== c) mismatch.push(f);
    else if (w === 0 && c === 0) unknown.push(f);
  }
  wdEmpty.sort(byCountDesc);
  mismatch.sort(byCountDesc);
  unknown.sort(byCountDesc);

  document.getElementById("not-flag-count").textContent =
    `— ${fmtTotal("records", notFlagOnly)}`;
  document.getElementById("no-image-count").textContent =
    `— ${fmtTotal("records", noImage)}`;
  document.getElementById("colors-count").textContent =
    `— ${(wdEmpty.length + mismatch.length).toLocaleString()} actionable, ${unknown.length.toLocaleString()} unknown`;

  const notFlagBody = document.getElementById("not-flag-rows");
  for (const rec of notFlagOnly) notFlagBody.appendChild(notFlagRow(rec));

  const noImageBody = document.getElementById("no-image-rows");
  for (const f of noImage) noImageBody.appendChild(noImageRow(f));

  document.getElementById("colors-wd-empty-head").textContent =
    `We have colors, Wikidata doesn't (${wdEmpty.length.toLocaleString()})`;
  const wdEmptyBody = document.getElementById("colors-wd-empty-rows");
  for (const f of wdEmpty) wdEmptyBody.appendChild(colorsWdEmptyRow(f));

  document.getElementById("colors-mismatch-head").textContent =
    `Color count mismatch (${mismatch.length.toLocaleString()})`;
  const mismatchBody = document.getElementById("colors-mismatch-rows");
  for (const f of mismatch) mismatchBody.appendChild(colorsMismatchRow(f));

  document.getElementById("colors-unknown-head").textContent =
    `Neither side has colors (${unknown.length.toLocaleString()})`;
  const unknownBody = document.getElementById("colors-unknown-rows");
  for (const f of unknown) unknownBody.appendChild(colorsUnknownRow(f));
}

main();
