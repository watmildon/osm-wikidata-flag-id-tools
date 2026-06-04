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
  if (flag.imageWithheld) return "flags/placeholder.svg";
  // Side-channel override (e.g. fair-use images we can't host on Commons).
  // Served direct from flags/local/; SVG/PNG/JPG all work, browser scales.
  if (flag.localFile) return `flags/local/${flag.localFile}`;
  if (!flag.file) return "flags/placeholder.svg";
  return `flags/thumb/${flag.qid}.png`;
}

export function fullSrc(flag) {
  if (flag.imageWithheld) return "flags/placeholder.svg";
  if (flag.localFile) return `flags/local/${flag.localFile}`;
  if (!flag.file) return "flags/placeholder.svg";
  return `flags/full/${flag.qid}.png`;
}

// Reverse-side (Wikidata P7417) image for flags where the back differs from
// the front (Oregon, Paraguay, Saudi Arabia, etc.). Returns null when this
// flag has no separate reverse — callers should hide their flip UI in that
// case rather than show a broken image.
export function reverseSrc(flag) {
  if (!flag.reverseFile) return null;
  if (flag.imageWithheld) return null;
  if (flag.localFile) return null;
  return `flags/full/${flag.qid}-reverse.png`;
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

    // Image lives inside a wrapper so we can anchor the flip badge to the
    // image bounds (not the whole tile, which includes the name and count
    // text below). Same trick used by the detail dialog.
    const imgWrap = document.createElement("span");
    imgWrap.className = "tile-img-wrap";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Flag of ${f.name}`;
    img.src = thumbSrc(f);
    imgWrap.appendChild(img);

    const name = document.createElement("span");
    name.className = "tile-name";
    name.textContent = f.flagName ?? f.name;

    const count = document.createElement("span");
    count.className = "tile-count";
    count.textContent = (f.count ?? 0).toLocaleString();
    count.title = `${f.count?.toLocaleString() ?? 0} OSM uses`;

    btn.append(imgWrap, name, count);

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

    // Flag has a distinct reverse side: drop a small flip-control overlay
    // in the corner of the thumbnail. Clicking it swaps this tile's image
    // between obverse and reverse in place, without opening the detail
    // dialog. The tile itself remains clickable for the detail view.
    //
    // Rendered as a <span role="button"> rather than a real <button> because
    // it lives inside the tile's <button> and nested buttons are invalid HTML.
    // Keyboard support: Enter/Space activates, same as a real button.
    const reverse = reverseSrc(f);
    if (reverse) {
      const flipCtl = document.createElement("span");
      flipCtl.className = "badge-flip badge-flip-clickable";
      flipCtl.setAttribute("role", "button");
      flipCtl.setAttribute("tabindex", "0");
      flipCtl.title = "Flip to reverse side";
      flipCtl.setAttribute("aria-label", "Flip to reverse side");
      flipCtl.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 6h10l-2.5-2.5M14 10H4l2.5 2.5"/></svg>';
      let showingReverseTile = false;
      const toggleSide = (e) => {
        e.stopPropagation();
        e.preventDefault();
        showingReverseTile = !showingReverseTile;
        img.src = showingReverseTile ? reverse : thumbSrc(f);
        img.alt = showingReverseTile ? `Reverse of ${f.name}` : `Flag of ${f.name}`;
        flipCtl.title = showingReverseTile ? "Flip back to front" : "Flip to reverse side";
        flipCtl.setAttribute("aria-label", flipCtl.title);
      };
      flipCtl.addEventListener("click", toggleSide);
      flipCtl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") toggleSide(e);
      });
      imgWrap.appendChild(flipCtl);
    }

    btn.addEventListener("click", () => onTileClick(f));
    li.appendChild(btn);
    frag.appendChild(li);
  }
  root.appendChild(frag);

  const count = document.getElementById("count");
  count.textContent = `${flags.length} flag${flags.length === 1 ? "" : "s"}`;
}
