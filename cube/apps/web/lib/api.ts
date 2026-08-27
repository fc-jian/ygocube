// API client + per-player identity (dev_docs/06 §2.1, §6).
// Every player page lives at /t/:tid/<page>/:pid — identity is resolved per player:
//   pid comes from the URL; token from localStorage (yc_token_<tid>_<pid>) or cookies.
//   Missing token -> the page prompts for input (unless the tournament has auth disabled,
//   in which case pid alone is enough). The super admin token works as a universal token.

export interface Identity {
  tid: string;
  pid: string;
  token: string;
}

export function getCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

// 身份 cookie 按 tournament 隔离（yc_pid_<tid>/yc_token_<tid>），
// 避免同机多比赛时互相串号导致报名页误判"已登录"（dev_docs/06 §2.1）
export function setIdentityCookie(tid: string, pid: string, token: string): void {
  document.cookie = `yc_pid_${tid}=${encodeURIComponent(pid)}; path=/; max-age=86400; SameSite=Lax`;
  document.cookie = `yc_token_${tid}=${encodeURIComponent(token)}; path=/; max-age=86400; SameSite=Lax`;
}

export function clearIdentityCookies(tid?: string): void {
  if (tid) {
    document.cookie = `yc_pid_${tid}=; path=/; max-age=0`;
    document.cookie = `yc_token_${tid}=; path=/; max-age=0`;
  }
  // 兼容清理旧版全局 cookie
  document.cookie = 'yc_tid=; path=/; max-age=0';
  document.cookie = 'yc_pid=; path=/; max-age=0';
  document.cookie = 'yc_token=; path=/; max-age=0';
}

// per-player token store (same machine, multiple test users)
function tokenKey(tid: string, pid: string): string {
  return `yc_token_${tid}_${pid}`;
}

export function getStoredToken(tid: string, pid: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage.getItem(tokenKey(tid, pid)) ?? undefined;
}

export function storeToken(tid: string, pid: string, token: string): void {
  window.localStorage.setItem(tokenKey(tid, pid), token);
  setIdentityCookie(tid, pid, token); // keep the single-user cookie flow working too
}

export function clearStoredToken(tid: string, pid: string): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(tokenKey(tid, pid));
  if (typeof document !== 'undefined') clearIdentityCookies(tid);
}

export function readIdentity(tid?: string): Identity | null {
  if (tid) {
    const pid = getCookie(`yc_pid_${tid}`);
    const token = getCookie(`yc_token_${tid}`);
    if (pid && token) return { tid, pid, token };
    return null;
  }
  // 旧版全局 cookie 兜底
  const gTid = getCookie('yc_tid');
  const gPid = getCookie('yc_pid');
  const gToken = getCookie('yc_token');
  if (gTid && gPid && gToken) return { tid: gTid, pid: gPid, token: gToken };
  return null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(code);
  }
}

let manualIdentity: Identity | null = null;
export function setManualIdentity(id: Identity | null): void {
  manualIdentity = id;
}

// fetch headers carry the three-factor identity; non-ASCII player ids are percent-encoded
// (header values must be ISO-8859-1) and decoded by the backend.
function identityHeaders(id: Identity | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (id) {
    headers['X-Tournament-Id'] = id.tid;
    headers['X-Player-Id'] = encodeURIComponent(id.pid);
    headers['X-Token'] = id.token;
  }
  return headers;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; identity?: Identity | null; createUsername?: string; createToken?: string; adminToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const id = opts.identity !== undefined ? opts.identity : manualIdentity ?? readIdentity();
  const headers = identityHeaders(id);
  if (opts.createUsername) headers['X-Create-User'] = encodeURIComponent(opts.createUsername);
  if (opts.createToken) headers['X-Create-Token'] = encodeURIComponent(opts.createToken);
  if (opts.adminToken) headers['X-Admin-Token'] = encodeURIComponent(opts.adminToken);
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'HTTP_ERROR', data?.details);
  }
  return data as T;
}

// authenticated file download (e.g. ydk export) — plain <a href> would lack the identity headers
export async function apiDownload(path: string, identity: Identity | null): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: identityHeaders(identity) });
  if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR');
  // 优先使用后端 Content-Disposition 文件名（cube-deck-<tid>-<pid>-<timestamp>.ydk）
  const cd = res.headers.get('content-disposition') ?? '';
  const match = cd.match(/filename="?([^";]+)"?/);
  const filename = match ? decodeURIComponent(match[1]) : (path.split('/').pop() ?? 'download');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// resolve identity for a player page: pid from URL, token from store/cookie.
// Returns { identity } or { needToken: true } when the token is missing.
export function resolvePlayerIdentity(tid: string, pid: string): { identity: Identity } | { needToken: true } {
  const token = getStoredToken(tid, pid) ?? readIdentity(tid)?.token;
  if (!token) return { needToken: true };
  return { identity: { tid, pid, token } };
}
