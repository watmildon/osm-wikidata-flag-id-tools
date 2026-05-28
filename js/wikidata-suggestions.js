// Aggregates the dataset's Wikidata-quality signals into one consolidated
// view. Sections:
//   1. "Missing flag entity" — subjects (cities, organisations) that have
//      a P41 flag image on the subject's own entity but no dedicated
//      "flag of X" entity exists. Fix: create the flag entity on Wikidata.
//   2. "Not classified as a flag" — non-flag-qids.json minus the entries
//      already covered by review.json's P163 suggestions. Fix could be on
//      either side: edit Wikidata to add P31, or retag the OSM elements
//      (the wrong QID was used) — both buttons offered.
//   3. "Missing image" — flags.json records where file===null. Fix: add P18
//      on Wikidata.
//   4. "Colors" — diff between flags.json `wdColors` (raw from P462) and
//      `colors` (curated, post-override). Three sub-buckets.

// Mirror render.js's swatch palette. Kept in sync by hand because a shared
// module would couple two otherwise-independent entry points.
const COLOR_SWATCHES = {
  red: "#dc2626", white: "#ffffff", blue: "#1d4ed8", darkblue: "#1e2a5e",
  lightblue: "#7dd3fc", green: "#16a34a", yellow: "#facc15",
  black: "#111827", orange: "#ea580c", brown: "#92400e", purple: "#7e22ce",
  pink: "#ec4899", gray: "#9ca3af",
};

function wdUrl(qid) {
  return `https://www.wikidata.org/wiki/${qid}`;
}

function thumbUrl(qid) {
  return `flags/thumb/${qid}.png`;
}

// Overpass-turbo URL that finds every OSM element with flag:wikidata=qid.
// Same query review.js uses; duplicated here to keep these two pages
// independently loadable without a shared module.
function overpassTurboUrl(qid) {
  const query = `[out:json][timeout:60];
nwr["flag:wikidata"="${qid}"];
out center meta;`;
  return `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}&R`;
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

function wdEditCell(qid, tooltip = "Edit on Wikidata") {
  return actionsCell([{ href: wdUrl(qid), title: tooltip, icon: ICON_WIKIDATA }]);
}

// Inline SVG icons for the compact fix-action buttons. External-arrow for
// Wikidata (opens off-site); pencil for the local curator. Keeping them inline
// avoids an HTTP fetch per icon and lets them inherit currentColor.
const ICON_WIKIDATA =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10"/>' +
  '<path d="M9 2h5v5"/><path d="M14 2 7 9"/></svg>';
const ICON_PENCIL =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m11 2 3 3-8 8H3v-3z"/></svg>';
const ICON_MAP_PIN =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 14s5-4.5 5-8.5a5 5 0 0 0-10 0C3 9.5 8 14 8 14z"/>' +
  '<circle cx="8" cy="5.5" r="1.75"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 3v10M3 8h10"/></svg>';

// Multi-button cell. Each action is { href, title, icon, newTab? }. Used
// anywhere a row offers more than one fix path. Buttons live inside a
// wrapper div so the <td> stays a real table-cell and aligns with the row
// (display:flex on the <td> itself breaks vertical alignment).
function actionsCell(actions) {
  const td = document.createElement("td");
  td.className = "fix-actions";
  const inner = document.createElement("div");
  inner.className = "fix-actions-inner";
  for (const a of actions) {
    const link = document.createElement("a");
    link.href = a.href;
    if (a.newTab !== false) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    link.className = "icon-btn";
    link.title = a.title;
    link.setAttribute("aria-label", a.title);
    link.innerHTML = a.icon;
    inner.appendChild(link);
  }
  td.appendChild(inner);
  return td;
}

function numCell(n) {
  const td = document.createElement("td");
  td.className = "num";
  td.textContent = (n ?? 0).toLocaleString();
  return td;
}

// ---- Section: missing flag entity ----

// Wikidata "create a new item" URL. We can't deep-link statements via
// query params (Special:NewItem only takes label/description), so the
// editor will set instance-of + flag-of by hand after landing.
const WIKIDATA_NEW_ITEM_URL = "https://www.wikidata.org/wiki/Special:NewItem";

function missingEntityRow(rec) {
  const tr = document.createElement("tr");
  const subjCell = document.createElement("td");
  const a = document.createElement("a");
  a.href = wdUrl(rec.subject_qid);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = rec.subject_qid;
  subjCell.appendChild(a);
  subjCell.appendChild(document.createElement("br"));
  const name = document.createElement("span");
  name.className = "muted";
  name.textContent = rec.subject_name;
  subjCell.appendChild(name);
  tr.appendChild(subjCell);

  const kindCell = document.createElement("td");
  kindCell.textContent = rec.kind;
  tr.appendChild(kindCell);

  tr.appendChild(actionsCell([
    { href: wdUrl(rec.subject_qid), title: "Open subject on Wikidata", icon: ICON_WIKIDATA },
    { href: WIKIDATA_NEW_ITEM_URL, title: "Create new flag entity on Wikidata", icon: ICON_PLUS },
  ]));
  return tr;
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
  // Two fix paths: either Wikidata should classify this entity as a flag,
  // or the OSM mappers used the wrong QID and the tags should be retagged
  // to point at the actual flag entity. Both buttons offered.
  tr.appendChild(actionsCell([
    { href: wdUrl(rec.qid), title: "Open on Wikidata", icon: ICON_WIKIDATA },
    { href: overpassTurboUrl(rec.qid), title: "Find OSM tags in overpass-turbo", icon: ICON_MAP_PIN },
  ]));
  return tr;
}

// ---- Section 2: missing image ----

function noImageRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid, "Add P18 image on Wikidata"));
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
  tr.appendChild(wdEditCell(f.qid, "Add P462 colors on Wikidata"));
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
  // Mismatch could be either side's error — give the user both fix paths.
  tr.appendChild(actionsCell([
    { href: wdUrl(f.qid), title: "Edit on Wikidata", icon: ICON_WIKIDATA },
    { href: `curate.html?qid=${f.qid}`, title: "Curate locally", icon: ICON_PENCIL, newTab: false },
  ]));
  return tr;
}

function colorsUnknownRow(f) {
  const tr = document.createElement("tr");
  tr.appendChild(flagCell(f));
  tr.appendChild(numCell(f.count));
  tr.appendChild(wdEditCell(f.qid, "Add P462 colors on Wikidata"));
  return tr;
}

// ---- main ----

function fmtTotal(label, items) {
  if (items.length === 0) return "(none)";
  const total = items.reduce((n, r) => n + (r.count ?? 0), 0);
  return `${items.length.toLocaleString()} ${label}, covering ${total.toLocaleString()} OSM uses`;
}

async function main() {
  let review, nonFlag, flagsData, missingEntities;
  try {
    // review.json gives us the set of QIDs already actionable as an OSM-side
    // retag — those live on review.html, not here. We subtract them from the
    // "not classified as a flag" section so this page only shows records
    // where the *Wikidata* entity needs the fix.
    const [r1, r2, r3, r4] = await Promise.all([
      fetch("data/review.json"),
      fetch("data/non-flag-qids.json"),
      fetch("data/flags.json"),
      fetch("data/missing-flag-entities.json"),
    ]);
    if (!r1.ok || !r2.ok || !r3.ok || !r4.ok) throw new Error("data fetch failed");
    review   = await r1.json();
    nonFlag  = await r2.json();
    flagsData = await r3.json();
    missingEntities = await r4.json();
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

  const missing = missingEntities.entries ?? [];
  document.getElementById("missing-entity-count").textContent =
    `— ${missing.length.toLocaleString()} subject${missing.length === 1 ? "" : "s"}`;
  const missingBody = document.getElementById("missing-entity-rows");
  for (const rec of missing) missingBody.appendChild(missingEntityRow(rec));

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
