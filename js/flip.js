// Shared "flip to reverse side" control.
//
// A flag with a distinct reverse (Wikidata P7417, surfaced as `reverseFile`
// on the record) gets a small overlay button in the corner of its image;
// clicking it swaps the <img> between obverse and reverse in place. Used by
// the main grid, the detail dialog, and the curate / describe / review-*
// editor pages so the affordance looks and behaves identically everywhere.
//
// Dependency-free on purpose: the editor pages can import just this without
// pulling in the grid/filter machinery from render.js.

// Two horizontal arrows pointing opposite directions — the universal
// "flip / swap sides" affordance. Shown only when a flag has a reverse.
const FLIP_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 6h10l-2.5-2.5M14 10H4l2.5 2.5"/></svg>';

// Reverse-side image src for a flag, or null when it has none. Mirrors the
// obverse precedence: withheld and local-override flags never get a built
// reverse PNG, so they return null and callers hide their flip UI.
export function reverseSrc(flag) {
  if (!flag.reverseFile) return null;
  if (flag.imageWithheld) return null;
  if (flag.localFile) return null;
  return `flags/full/${flag.qid}-reverse.png`;
}

// Attach a flip control to a flag image, if the flag has a reverse side.
//   wrap     — positioned container the badge anchors to (must wrap `img`)
//   img      — the <img> whose src/alt toggle
//   flag     — the flag record
//   frontSrc — (flag) => obverse src; thumbSrc on the grid, fullSrc on the
//              editor pages. Used to flip back to the front.
// Returns true if a control was attached, false if the flag has no reverse.
//
// Rendered as a <span role="button"> (not a real <button>) so it stays valid
// inside the grid tile's own <button>; Enter/Space activate it like a button.
// Each call closes over its own showing-reverse state, which is exactly what
// virtualized lists need — a rebuilt row starts on the obverse again.
export function attachFlipControl(wrap, img, flag, frontSrc) {
  const reverse = reverseSrc(flag);
  if (!reverse) return false;
  const flipCtl = document.createElement("span");
  flipCtl.className = "badge-flip badge-flip-clickable";
  flipCtl.setAttribute("role", "button");
  flipCtl.setAttribute("tabindex", "0");
  flipCtl.title = "Flip to reverse side";
  flipCtl.setAttribute("aria-label", "Flip to reverse side");
  flipCtl.innerHTML = FLIP_ICON;
  let showingReverse = false;
  const toggleSide = (e) => {
    e.stopPropagation();
    e.preventDefault();
    showingReverse = !showingReverse;
    img.src = showingReverse ? reverse : frontSrc(flag);
    img.alt = showingReverse ? `Reverse of ${flag.name}` : `Flag of ${flag.name}`;
    flipCtl.title = showingReverse ? "Flip back to front" : "Flip to reverse side";
    flipCtl.setAttribute("aria-label", flipCtl.title);
  };
  flipCtl.addEventListener("click", toggleSide);
  flipCtl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggleSide(e);
  });
  wrap.appendChild(flipCtl);
  return true;
}
