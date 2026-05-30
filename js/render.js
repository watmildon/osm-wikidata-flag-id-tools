import { getState, toggleColor, toggleIcon, setShape } from "./filters.js";

const COLOR_SWATCHES = {
  red: "#dc2626",
  white: "#ffffff",
  blue: "#1d4ed8",
  darkblue: "#1e2a5e",
  lightblue: "#7dd3fc",
  green: "#16a34a",
  yellow: "#facc15",
  black: "#111827",
  orange: "#ea580c",
  brown: "#92400e",
  purple: "#7e22ce",
  pink: "#ec4899",
  gray: "#9ca3af",
};

const ICON_LABELS = {
  text: "Text",
  animal: "Animal",
  bird: "Bird",
  people: "People",
  plant: "Plant",
  star: "Star",
  sun: "Sun",
  cross: "Cross",
  crescent: "Crescent",
  circle: "Circle",
  "horizontal-stripes": "Horizontal stripes",
  "vertical-stripes": "Vertical stripes",
  triangle: "Triangle",
  diagonal: "Diagonal",
  weapon: "Weapon",
  map: "Map",
  building: "Building",
  coa: "Coat of arms",
  crown: "Crown",
  tools: "Tools",
  water: "Water",
  ship: "Ship",
};

const SHAPE_LABELS = {
  rectangle: "Rectangle",
  square: "Square",
  pennant: "Pennant",
  other: "Other",
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
  if (flag.imageWithheld || !flag.file) return "flags/placeholder.svg";
  return `flags/thumb/${flag.qid}.png`;
}

export function fullSrc(flag) {
  if (flag.imageWithheld || !flag.file) return "flags/placeholder.svg";
  return `flags/full/${flag.qid}.png`;
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
    if (f.imageWithheld) btn.classList.add("tile-withheld");
    else if (!f.file) btn.classList.add("tile-warn");

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Flag of ${f.name}`;
    img.src = thumbSrc(f);

    const name = document.createElement("span");
    name.className = "tile-name";
    name.textContent = f.flagName ?? f.name;

    const count = document.createElement("span");
    count.className = "tile-count";
    count.textContent = (f.count ?? 0).toLocaleString();
    count.title = `${f.count?.toLocaleString() ?? 0} OSM uses`;

    btn.append(img, name, count);

    if (f.imageWithheld) {
      const badge = document.createElement("span");
      badge.className = "badge-withheld";
      badge.textContent = "image withheld";
      badge.title = "The flag design is copyrighted or otherwise can't be redistributed. Use the description and tags below.";
      btn.appendChild(badge);
    } else if (!f.file) {
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
