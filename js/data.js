let cache = null;

export async function loadFlags() {
  if (cache) return cache;
  const res = await fetch("data/flags.json");
  if (!res.ok) throw new Error(`flags.json: HTTP ${res.status}`);
  cache = await res.json();
  return cache;
}
