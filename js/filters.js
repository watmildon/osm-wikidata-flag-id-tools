const state = {
  colors: new Set(),
  icons: new Set(),
  shape: null,
  query: "",
};

const listeners = new Set();
function notify() {
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

export function toggleColor(c) {
  state.colors.has(c) ? state.colors.delete(c) : state.colors.add(c);
  notify();
}

export function toggleIcon(i) {
  state.icons.has(i) ? state.icons.delete(i) : state.icons.add(i);
  notify();
}

export function setShape(s) {
  state.shape = state.shape === s ? null : s;
  notify();
}

export function setQuery(q) {
  const next = (q ?? "").trim().toLowerCase();
  if (state.query === next) return;
  state.query = next;
  notify();
}

export function clear() {
  state.colors.clear();
  state.icons.clear();
  state.shape = null;
  state.query = "";
  notify();
}

export function activeCount() {
  return state.colors.size + state.icons.size + (state.shape ? 1 : 0) + (state.query ? 1 : 0);
}

// Note: flags.json no longer contains non-flag entities. The build pipeline
// drops records that fail the flag-entity check AND have no curator vouch
// (localFile / imageWithheld / overrides.json entry) before writing
// flags.json. So everything reaching this module is already a "verified
// flag" by construction — no per-record gate needed here.

export function matches(flag) {
  for (const c of state.colors) {
    if (!flag.colors?.includes(c)) return false;
  }
  for (const i of state.icons) {
    if (!flag.icons?.includes(i)) return false;
  }
  if (state.shape && flag.shape !== state.shape) return false;
  if (state.query) {
    const haystack = [flag.name, flag.flagName, flag.description].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  return true;
}
