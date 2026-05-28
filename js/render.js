import { getState, toggleColor, toggleIcon, setShape } from "./filters.js";

const COLOR_SWATCHES = {
  red: "#dc2626",
  white: "#ffffff",
  blue: "#1d4ed8",
  green: "#16a34a",
  yellow: "#facc15",
  black: "#111827",
  orange: "#ea580c",
  lightblue: "#7dd3fc",
  brown: "#92400e",
  purple: "#7e22ce",
};

const ICON_LABELS = {
  text: "Text",
  animal: "Animal",
  people: "People",
  star: "Star",
  cross: "Cross",
  stripes: "Stripes",
  circle: "Circle",
  crescent: "Crescent",
  coa: "Coat of arms",
};

const SHAPE_LABELS = {
  "1:2": "1:2",
  "2:3": "2:3",
  "3:5": "3:5",
  square: "Square",
  pennant: "Pennant",
  other: "Other",
  unknown: "Unknown",
};

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

export function renderFilters(meta) {
  const state = getState();

  const colorRoot = document.getElementById("color-chips");
  colorRoot.innerHTML = "";
  for (const c of meta.palette) {
    colorRoot.appendChild(
      chip({
        label: c,
        swatchColor: COLOR_SWATCHES[c],
        pressed: state.colors.has(c),
        onClick: () => toggleColor(c),
      })
    );
  }

  const iconRoot = document.getElementById("icon-chips");
  iconRoot.innerHTML = "";
  for (const i of meta.icons) {
    iconRoot.appendChild(
      chip({
        label: ICON_LABELS[i] ?? i,
        pressed: state.icons.has(i),
        onClick: () => toggleIcon(i),
      })
    );
  }

  const shapeRoot = document.getElementById("shape-chips");
  shapeRoot.innerHTML = "";
  for (const s of meta.shapes) {
    shapeRoot.appendChild(
      chip({
        label: SHAPE_LABELS[s] ?? s,
        pressed: state.shape === s,
        onClick: () => setShape(s),
      })
    );
  }
}

export function updateFilterSummary(active) {
  const el = document.getElementById("filter-summary");
  el.textContent = active === 0 ? "" : `${active} active`;
}

export function thumbSrc(flag) {
  return flag.file ? `flags/thumb/${flag.qid}.png` : "flags/placeholder.svg";
}

export function fullSrc(flag) {
  return flag.file ? `flags/full/${flag.qid}.png` : "flags/placeholder.svg";
}

export function renderGrid(flags, onTileClick) {
  const root = document.getElementById("grid");
  root.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const f of flags) {
    const li = document.createElement("li");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tile";
    btn.dataset.qid = f.qid;
    btn.setAttribute("aria-label", `${f.name} — copy OSM tags`);
    if (!f.file) btn.classList.add("tile-warn");

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Flag of ${f.name}`;
    img.src = thumbSrc(f);

    const name = document.createElement("span");
    name.className = "tile-name";
    name.textContent = f.name;

    btn.append(img, name);

    if (!f.file) {
      const badge = document.createElement("span");
      badge.className = "badge-warn";
      badge.textContent = "no image";
      badge.title = "No image set on the Wikidata entity (P18). Either add one, or the QID is the wrong one for this flag.";
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => onTileClick(f));
    li.appendChild(btn);
    frag.appendChild(li);
  }
  root.appendChild(frag);

  const count = document.getElementById("count");
  count.textContent = `${flags.length} flag${flags.length === 1 ? "" : "s"}`;
}
