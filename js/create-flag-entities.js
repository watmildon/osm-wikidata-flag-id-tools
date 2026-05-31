// Page for batch-creating "flag of X" Wikidata entities via QuickStatements.
//
// Reads data/missing-flag-entities-auto.json (auto-detected P41-without-P163
// subjects from refresh-p41-p163.mjs), shows them in a checkbox list with
// thumbnail previews, and generates a QuickStatements batch for selected rows.

const COMMONS_THUMB_BASE = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const COMMONS_FILE_BASE = "https://commons.wikimedia.org/wiki/File:";
const WD_BASE = "https://www.wikidata.org/wiki/";
const QS_TOOL_URL = "https://quickstatements.toolforge.org/";

const STORAGE_KEY = "osm-flag-create-entities-selected";

function loadSelection() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")); }
  catch { return new Set(); }
}
function saveSelection(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
}

function showToast(msg, ms = 1800) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Wikidata commons URL for a filename, scaled to fit the row preview.
function commonsThumbUrl(filename) {
  return `${COMMONS_THUMB_BASE}${encodeURIComponent(filename)}?width=240`;
}
function commonsFileUrl(filename) {
  return `${COMMONS_FILE_BASE}${encodeURIComponent(filename.replace(/ /g, "_"))}`;
}

// Build a QuickStatements CREATE block for one row. Format per
// https://www.wikidata.org/wiki/Help:QuickStatements.
//
// We emit minimal statements — anything sub-typed (state flag, national flag,
// etc.) is left for the human to add on Wikidata after creation, since guessing
// from a subject's class is unreliable.
function quickStatementsFor(entry, filename) {
  const subjectName = entry.subject_name;
  const subjectQid = entry.subject_qid;
  // QS string syntax: double-quoted strings, no escaping for our content
  // unless the name contains a quote. Belt-and-braces escape both quotes
  // and backslashes per QS docs.
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "CREATE",
    `LAST\tLen\t"flag of ${escape(subjectName)}"`,
    `LAST\tDen\t"flag"`,
    `LAST\tP31\tQ14660`,
    `LAST\tP163\t${subjectQid}`,
    `LAST\tP18\t"${escape(filename)}"`,
  ].join("\n");
}

function row(entry, selected) {
  const tr = document.createElement("div");
  tr.className = "cfe-row" + (selected ? " selected" : "");
  tr.dataset.qid = entry.subject_qid;
  tr.dataset.isSvg = entry.p41_files?.[0]?.toLowerCase().endsWith(".svg") ? "1" : "0";
  tr.dataset.osmCount = String(entry.count ?? 0);

  // Checkbox
  const selCell = document.createElement("div");
  selCell.className = "select-cell";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected;
  cb.setAttribute("aria-label", `Include ${entry.subject_name} in QuickStatements batch`);
  selCell.appendChild(cb);
  tr.appendChild(selCell);

  // Image preview (first P41 file)
  const imgCell = document.createElement("div");
  imgCell.className = "img-cell";
  const filename = entry.p41_files?.[0];
  if (filename) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `${entry.subject_name} flag`;
    img.src = commonsThumbUrl(filename);
    img.addEventListener("error", () => img.classList.add("broken"));
    imgCell.appendChild(img);
  }
  tr.appendChild(imgCell);

  // Metadata
  const meta = document.createElement("div");
  meta.className = "meta";

  const h = document.createElement("h3");
  h.textContent = entry.subject_name;
  meta.appendChild(h);

  const qidLine = document.createElement("p");
  qidLine.className = "line";
  const qidLink = document.createElement("a");
  qidLink.href = WD_BASE + entry.subject_qid;
  qidLink.target = "_blank";
  qidLink.rel = "noopener";
  qidLink.textContent = entry.subject_qid;
  qidLine.appendChild(qidLink);
  qidLine.append(` · ${(entry.count ?? 0).toLocaleString()} OSM use${entry.count === 1 ? "" : "s"}`);
  meta.appendChild(qidLine);

  // P41 filename(s) — clickable Commons link so user can verify the image.
  if (entry.p41_files?.length) {
    for (const f of entry.p41_files) {
      const fileLine = document.createElement("p");
      fileLine.className = "line";
      const span = document.createElement("span");
      span.className = "filename";
      span.textContent = f;
      fileLine.appendChild(span);
      const a = document.createElement("a");
      a.href = commonsFileUrl(f);
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "preview-link";
      a.textContent = "view on Commons →";
      fileLine.appendChild(document.createTextNode(" "));
      fileLine.appendChild(a);
      meta.appendChild(fileLine);
    }
    if (entry.p41_files.length > 1) {
      const warn = document.createElement("p");
      warn.className = "line";
      warn.style.color = "var(--accent)";
      warn.textContent = `⚠ ${entry.p41_files.length} P41 images — only the first will be used (P18). Edit on Wikidata to add the rest as alternatives.`;
      meta.appendChild(warn);
    }
  }

  tr.appendChild(meta);

  cb.addEventListener("change", () => {
    tr.classList.toggle("selected", cb.checked);
    onSelectionChanged();
  });

  return { node: tr, checkbox: cb };
}

// Module-scope state — populated by main().
let allRows = []; // [{ entry, node, checkbox }]
let selection = new Set();

function applyFilters() {
  const hideZero = document.getElementById("hide-zero-osm").checked;
  const hidePng = document.getElementById("hide-png").checked;
  let visible = 0;
  for (const r of allRows) {
    const count = Number(r.node.dataset.osmCount);
    const isSvg = r.node.dataset.isSvg === "1";
    const hide = (hideZero && count === 0) || (hidePng && !isSvg);
    r.node.style.display = hide ? "none" : "";
    if (!hide) visible++;
  }
  document.getElementById("cfe-status").textContent =
    `${visible.toLocaleString()} shown · ${selection.size.toLocaleString()} selected`;
}

function onSelectionChanged() {
  selection.clear();
  for (const r of allRows) {
    if (r.checkbox.checked) selection.add(r.entry.subject_qid);
  }
  saveSelection(selection);
  document.getElementById("generate-btn").disabled = selection.size === 0;
  applyFilters(); // updates count in status line
}

function selectAllVisible(value) {
  for (const r of allRows) {
    if (r.node.style.display === "none") continue;
    r.checkbox.checked = value;
    r.node.classList.toggle("selected", value);
  }
  onSelectionChanged();
}

function renderOutput() {
  let outputEl = document.getElementById("cfe-output");
  if (!outputEl) {
    outputEl = document.createElement("div");
    outputEl.id = "cfe-output";
    outputEl.className = "cfe-output";
    outputEl.innerHTML = `
      <h2>QuickStatements batch</h2>
      <p>Copy the text below, then paste into the
        <a href="${QS_TOOL_URL}" target="_blank" rel="noopener">QuickStatements tool</a>
        on Wikimedia Toolforge. Use the "v1" format (the tab-separated one).
      </p>
      <textarea id="cfe-output-text" readonly></textarea>
      <div class="output-actions">
        <button type="button" id="cfe-copy-btn">Copy to clipboard</button>
        <button type="button" id="cfe-close-btn">Close</button>
      </div>
    `;
    // Insert just above the toolbar — append to main so it lives in the
    // scrollable region but stays under the rows for natural reading order.
    document.querySelector(".cfe-main").appendChild(outputEl);
    document.getElementById("cfe-copy-btn").addEventListener("click", async () => {
      const txt = document.getElementById("cfe-output-text").value;
      try {
        await navigator.clipboard.writeText(txt);
        showToast(`Copied ${selection.size} CREATE block${selection.size === 1 ? "" : "s"}`);
      } catch {
        // Fallback: select the textarea so user can ctrl-c
        const ta = document.getElementById("cfe-output-text");
        ta.focus();
        ta.select();
        showToast("Selected — press Ctrl+C to copy");
      }
    });
    document.getElementById("cfe-close-btn").addEventListener("click", () => {
      outputEl.remove();
    });
  }

  const selectedRows = allRows.filter((r) => selection.has(r.entry.subject_qid));
  const blocks = [];
  for (const r of selectedRows) {
    const filename = r.entry.p41_files?.[0];
    if (!filename) continue; // skip entries without P41 — shouldn't happen given source data
    blocks.push(quickStatementsFor(r.entry, filename));
  }
  document.getElementById("cfe-output-text").value = blocks.join("\n\n") + "\n";
  outputEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function main() {
  let auto;
  try {
    auto = await fetchJson("data/missing-flag-entities-auto.json");
  } catch (err) {
    document.getElementById("cfe-status").textContent =
      `Failed to load missing-flag-entities-auto.json (${err.message}). Run \`npm run refresh:p41-p163\` first.`;
    return;
  }

  const entries = (auto.entries ?? [])
    .filter((e) => e.p41_files?.length > 0) // need at least one image
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  selection = loadSelection();
  const root = document.getElementById("cfe-rows");
  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const r = row(entry, selection.has(entry.subject_qid));
    allRows.push({ entry, node: r.node, checkbox: r.checkbox });
    frag.appendChild(r.node);
  }
  root.appendChild(frag);

  document.getElementById("hide-zero-osm").addEventListener("change", applyFilters);
  document.getElementById("hide-png").addEventListener("change", applyFilters);
  document.getElementById("select-all-btn").addEventListener("click", () => selectAllVisible(true));
  document.getElementById("select-none-btn").addEventListener("click", () => selectAllVisible(false));
  document.getElementById("generate-btn").addEventListener("click", renderOutput);

  // Initialize: drop any saved selections for QIDs that aren't in the current
  // dataset (the auto file regenerates so QIDs can come and go).
  const validQids = new Set(entries.map((e) => e.subject_qid));
  for (const q of [...selection]) if (!validQids.has(q)) selection.delete(q);
  saveSelection(selection);
  document.getElementById("generate-btn").disabled = selection.size === 0;

  applyFilters();
}

main();
