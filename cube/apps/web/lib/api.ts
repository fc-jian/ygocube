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

/**
 * Encode one dynamic URL path segment.  Player IDs may contain spaces (and
 * other characters that are legal in the protocol but meaningful to a URL),
 * so every route link and API path must use this helper instead of interpolating
 * the raw value.  encodeURIComponent intentionally renders spaces as `%20`.
 */
export function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
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

// Keep implementation error codes out of user-facing messages.  The API still
// returns stable codes for programmatic handling, but pages should use this
// helper for the fallback shown in a banner or form.  Unknown failures use a
// deliberately generic message so stack traces, routes and database details
// never leak into the UI.
const API_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '请先验证身份后再操作',
  FORBIDDEN: '当前凭据无权执行此操作',
  BAD_PAYLOAD: '提交的信息不完整或格式不正确',
  BAD_PLAYER_ID: '玩家 ID 格式不正确',
  BAD_DISPLAY_NAME: '显示名称格式不正确',
  ALREADY_JOINED: '该玩家 ID 已报名',
  TOURNAMENT_FULL: '比赛报名人数已满',
  TOURNAMENT_NOT_FOUND: '比赛不存在或已结束',
  PLAYER_NOT_FOUND: '找不到该玩家',
  WRONG_PHASE: '当前阶段不允许此操作',
  DRAFT_NOT_STARTED: '选牌尚未开始',
  NOT_YOUR_TURN: '当前还没有轮到你选牌',
  CARD_NOT_AVAILABLE: '这张卡已被选走，请刷新后重试',
  CARD_NOT_IN_POOL: '这张卡不在当前卡池中',
  CARD_NOT_IN_ZONE: '这张卡不在指定区域',
  WRONG_ZONE: '该类型卡不能放入此区域',
  FROZEN: '比赛已暂停，请等待管理员恢复',
  PAUSED: '比赛已暂停，请等待管理员恢复',
  PAUSE_EXISTS: '比赛已经暂停',
  NOT_PAUSED: '比赛当前没有暂停',
  DECK_INVALID: '卡组不符合当前规则，请检查卡组数量和卡片',
  LOCKED: '卡组已经锁定，不能再修改',
  ALREADY_LOCKED: '卡组已经锁定',
  POOL_NOT_FOUND: '卡池不存在或已被删除',
  POOL_EXISTS: '卡池名称已存在',
  POOL_IN_USE: '卡池仍被比赛使用，暂时不能删除',
  BAD_POOL_NAME: '卡池名称只能使用字母、数字、点、下划线或连字符',
  BAD_POOL_IMPORT: '卡池内容中没有可导入的有效编号',
  BAD_MATCH_FORMAT: '赛制设置不正确',
  BAD_SWISS_ROUNDS: '瑞士轮数设置不正确',
  BAD_PLAYOFF_SIZE: '淘汰赛人数设置不正确',
  FORMAT_LOCKED: '首轮开始后不能修改赛制',
  FORMAT_PLAYER_COUNT: '当前报名人数不适合该赛制',
  NOT_ENOUGH_PLAYERS: '报名人数不足，无法开始选牌',
  DRAFT_START_PENDING: '已发起开始选牌确认，请等待玩家完成确认',
  DRAFT_START_NOT_PENDING: '当前没有待确认的开始选牌请求',
  DRAFT_START_EXPIRED: '确认时间已结束，选牌未开始；请管理员重新发起',
  PACKCOUNT_NOT_MULTIPLE: '牌堆总数必须是玩家数的整数倍',
  INSUFFICIENT_PACK_RATIO: '卡池数量不足，无法按比例组包',
  BAD_EXTRA_RATIO: '额外卡比例必须是 0 到 100 的整数',
  BAD_RESERVE_SECONDS: '保留时间必须是有效的正数',
  BAD_SMALL_WORLD_INPUT: '小世界分析输入格式不正确',
  MATCH_NOT_FOUND: '找不到该对局',
  NO_VALID_PAIRING: '当前没有可用的配对',
  ROUND_EXISTS: '该轮对局已经生成',
  ROUND_PENDING: '上一轮对局尚未结束',
  RESULT_ROUND_LOCKED: '该轮结果已经锁定',
  REVERT_CONFIRMATION_MISMATCH: '确认信息不匹配，未执行回溯',
  REVERT_EVENT_NOT_FOUND: '找不到要回溯的事件',
  PAUSE_VOTING_REMOVED: '暂停投票已取消，请联系管理员操作',
  ADMIN_TOKEN_REMOVED: '比赛管理令牌已取消，请使用创建者凭据',
  CREATE_USER_EXISTS: '该权限用户名已存在',
  CREATE_USER_NOT_FOUND: '找不到该权限用户',
  BAD_CREATE_USERNAME: '权限用户名格式不正确',
  REQUEST_TOO_LARGE: '请求内容过大，请减少输入后重试',
  STREAM_LIMIT: '当前连接数已达上限，请稍后重试',
  CORS_ORIGIN_DENIED: '当前访问来源不被允许',
  INTERNAL_ERROR: '服务器暂时不可用，请稍后重试',
  HTTP_ERROR: '网络请求失败，请稍后重试',
};

export function apiErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string' && value.code) return value.code;
  return typeof value.message === 'string' ? value.message : '';
}

export function readableApiError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  const code = apiErrorCode(error);
  return API_ERROR_MESSAGES[code] ?? fallback;
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
