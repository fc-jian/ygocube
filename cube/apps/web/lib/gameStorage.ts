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

export type RoomGame = 'guess' | 'dg';
interface RecentRoom { id: string; name: string }
const RECENT_LIMIT = 3;
const roomCode = /^[0-9A-F]{8}$/;

export function recentGameRooms(game: RoomGame): RecentRoom[] {
  const saved = readGameValue(`yc_${game}_recent`);
  if (saved !== null) {
    try {
      const rows: unknown = JSON.parse(saved);
      if (Array.isArray(rows)) return rows.filter((r) => r && typeof r.id === 'string'
        && roomCode.test(r.id) && typeof r.name === 'string').slice(0, RECENT_LIMIT);
    } catch { /* Recover from existing seat keys if the index is unreadable. */ }
  }
  const prefix = `yc_${game}_session_`;
  const keys = new Set(overrides.keys());
  for (const storageName of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = window[storageName];
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.add(key);
      }
    } catch { /* Storage can be disabled for this tab. */ }
  }
  return [...keys].filter((key) => key.startsWith(prefix) && roomCode.test(key.slice(prefix.length))
    && readGameValue(key)).slice(0, RECENT_LIMIT).map((key) => ({ id: key.slice(prefix.length), name: '' }));
}

export function rememberGameRoom(game: RoomGame, room: { roomId: string; name: string }): void {
  const id = room.roomId.toUpperCase();
  if (!roomCode.test(id)) return;
  const entries = recentGameRooms(game);
  if (entries[0]?.id === id && entries[0].name === room.name) return;
  const next = [{ id, name: room.name }, ...entries.filter((entry) => entry.id !== id)].slice(0, RECENT_LIMIT);
  writeGameValue(`yc_${game}_recent`, JSON.stringify(next));
}

export function forgetGameRoom(game: RoomGame, roomId: string): void {
  const entries = recentGameRooms(game);
  const next = entries.filter((entry) => entry.id !== roomId.toUpperCase());
  if (entries.length !== next.length) writeGameValue(`yc_${game}_recent`, JSON.stringify(next));
}
