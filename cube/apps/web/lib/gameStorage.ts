// A room creation/join has already committed when its token reaches the browser.
// Keep a tab fallback when persistence is unavailable, including denied getters.
const overrides = new Map<string, string | null>();

export function readGameValue(key: string): string | null {
  if (overrides.has(key)) return overrides.get(key) ?? null;
  try {
    const fallback = window.sessionStorage.getItem(key);
    if (fallback !== null) return fallback || null;
  } catch { /* Try the original persistent key. */ }
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

export function writeGameValue(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    window.sessionStorage.removeItem(key);
    overrides.delete(key);
  } catch {
    // An empty fallback masks an older persistent token after logout.
    overrides.set(key, value);
    try { window.sessionStorage.setItem(key, value ?? ''); }
    catch { /* Client navigation can still recover the in-memory seat. */ }
  }
}
