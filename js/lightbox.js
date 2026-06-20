// Shared click-to-zoom lightbox for the editor pages (describe / review-*).
//
// Each page calls mountLightbox(getSrc) once. The module injects a single
// <dialog class="lightbox"> at the end of <body>, wires close behavior, and
// returns { openLightbox(flag), attachZoom(img, flag) } for the page to use
// per row. getSrc maps a flag to the image url the lightbox shows — usually
// the same thumbSrc the row uses, since flags/full/<QID>.png is already a
// big-enough image for fine-detail review.
//
// CSS lives in styles.css under the `.lightbox` selectors so all consumers
// share the same look. The styles match describe.html's original inline
// styles 1:1, just promoted to the shared sheet.

import { attachFlipControl } from "./flip.js";

const LIGHTBOX_HTML = `
  <button class="lightbox-close" type="button" aria-label="Close">&times;</button>
  <figure class="lightbox-fig">
    <span class="flip-img-wrap lightbox-img-wrap"><img class="lightbox-img" alt="" /></span>
    <figcaption class="lightbox-cap"></figcaption>
  </figure>
`;

// True when the flag's image is a real flag rather than the placeholder.
// Withheld images and missing files both render as the question-mark
// placeholder, where zooming would be pointless.
function hasRealImage(flag) {
  return !flag.imageWithheld && Boolean(flag.localFile || flag.file);
}

// Mount the lightbox once per page. Returns helpers the page wires per row.
//   getSrc(flag) → string : the obverse image url shown in the lightbox.
//                          For pages whose rows already display flags/full/*
//                          PNGs, pass the same thumbSrc function — the
//                          400px size reads well at lightbox dimensions.
export function mountLightbox(getSrc) {
  let dlg = document.querySelector("dialog.lightbox");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "lightbox";
    dlg.setAttribute("aria-label", "Enlarged flag image");
    dlg.innerHTML = LIGHTBOX_HTML;
    document.body.appendChild(dlg);
    dlg.querySelector(".lightbox-close").addEventListener("click", () => dlg.close());
    // Backdrop click → close. e.target is the dialog itself only when the
    // user clicked the backdrop area outside the dialog content.
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  }
  const wrap = dlg.querySelector(".lightbox-img-wrap");
  const img = dlg.querySelector(".lightbox-img");
  const cap = dlg.querySelector(".lightbox-cap");

  function openLightbox(flag) {
    img.src = getSrc(flag);
    img.alt = `Flag of ${flag.name}`;
    // Drop the previous flag's flip control, then re-attach for this one.
    wrap.querySelector(".badge-flip")?.remove();
    attachFlipControl(wrap, img, flag, getSrc);
    cap.textContent = `${flag.flagName ?? flag.name} · `;
    const a = document.createElement("a");
    a.href = `https://www.wikidata.org/wiki/${flag.qid}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = flag.qid;
    // Reset the caption's child element since textContent above clobbered it.
    cap.appendChild(a);
    dlg.showModal();
  }

  // Make a row's <img> open the lightbox on click / Enter / Space. Safe to
  // call on every row — no-op for flags without a real image. The flip
  // badge sits on top of the image and stops propagation, so it flips in
  // place rather than zooming.
  function attachZoom(img, flag) {
    if (!hasRealImage(flag)) return;
    img.classList.add("zoomable");
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("aria-label", `View larger image of ${flag.name}`);
    img.addEventListener("click", () => openLightbox(flag));
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLightbox(flag);
      }
    });
  }

  return { openLightbox, attachZoom };
}
