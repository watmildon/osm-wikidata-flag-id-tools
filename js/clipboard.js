export function tagsFor(flag) {
  const lines = [];
  if (flag.flagType) lines.push(`flag:type=${flag.flagType}`);
  lines.push(`flag:wikidata=${flag.qid}`);
  lines.push(`flag:name=${flag.flagName ?? flag.name}`);
  // Extra tags from the Name Suggestion Index — these match what iD would
  // suggest for the same flag.
  if (flag.extraTags) {
    for (const [k, v] of Object.entries(flag.extraTags)) {
      lines.push(`${k}=${v}`);
    }
  }
  return lines.join("\n");
}

export async function copyTags(flag) {
  const text = tagsFor(flag);
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text, error: e?.message ?? String(e) };
  }
}

let toastTimer = null;
export function showToast(msg, ms = 1800) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
