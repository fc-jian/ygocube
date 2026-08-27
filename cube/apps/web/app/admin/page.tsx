'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface AdminState {
  id: number;
  name: string;
  createdBy?: string;
  status: string;
  round: number;
  frozen: boolean;
  authRequired: boolean;
  config: Record<string, unknown>;
  players: { playerId: string; displayName: string; seat: number; eliminated?: boolean; withdrawn?: boolean }[];
  packs: { index: number; size: number; dropCard: number | null; order: number[] }[];
  picks: { playerId: string; packIndex: number; round: number; card: number; auto: boolean }[];
  pickCursor: { packIndex: number; round: number; playerId: string; deadlineAt: string } | null;
  pickDeadlines?: Record<string, string | null>;
  pickReserves?: Record<string, number>;
  pickAlternatives?: Record<string, { packIndex: number; card: number } | null>;
  pendingPhase: string | null;
  pause: { pausedAt: string; actor?: string } | null;
  decks: Record<string, { main: number[]; extra: number[]; side: number[]; lockedAt: string | null }>;
  matches: { id: number; round: number; playerA: string; playerB: string; tableNo: number; roomName: string | null; resultA: number | null; resultB: number | null; faultedAt: string | null; stage?: string; bracketRound?: number }[];
  pickSummary: { playerId: string; seat: number; count: number }[];
}

interface PoolInfo {
  id: number;
  name: string;
  count: number;
  createdAt: string;
  isDefault?: boolean;
  url?: string | null;
}

interface PoolImportReport {
  filtered: number;
  missingCodes: number[];
  invalidEntries?: string[];
  entryWarnings?: {
    line: number;
    input: string;
    kind: 'invalid' | 'missing_code' | 'name_mismatch';
    code?: number;
    submittedName?: string;
    actualName?: string;
  }[];
}

interface TournamentBrief {
  id: number;
  name: string;
  status: string;
  round: number;
  player_count: number;
  frozen: number;
  created_at: string;
  created_by?: string;
}

export default function AdminPage() {
  // Super token is global; creator credentials are scoped by the server to
  // tournaments owned by that username. Never put either credential in URLs.
  const [adminToken, setAdminToken] = useState('');
  const [createUsername, setCreateUsername] = useState('');
  const [createToken, setCreateToken] = useState('');
  const [tid, setTid] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [canEditPools, setCanEditPools] = useState(false);
  const [poolName, setPoolName] = useState('');
  const [poolCodes, setPoolCodes] = useState('');
  const [poolSize, setPoolSize] = useState(1000);
  const [poolReport, setPoolReport] = useState<PoolImportReport | null>(null);
  const [deletingPoolId, setDeletingPoolId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [msgKey, setMsgKey] = useState(0);
  const msgHideKey = useRef(0);
  // 右上角操作反馈：显示 8 秒后自动消失（不再被 5 秒轮询的 load() 清掉）
  const showMsg = (m: string) => {
    setMsg(m);
    setMsgKey((k) => k + 1);
    const k = ++msgHideKey.current;
    setTimeout(() => {
      if (msgHideKey.current === k) setMsg('');
    }, 8000);
  };
  const [tournaments, setTournaments] = useState<TournamentBrief[]>([]);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string | number | boolean>>({});
  const loadSeq = useRef(0);
  const [addPid, setAddPid] = useState('');
  const [shownToken, setShownToken] = useState<{ pid: string; token: string } | null>(null);
  const [matchInputs, setMatchInputs] = useState<Record<number, { a: string; b: string }>>({});
  const [events, setEvents] = useState<{ seq: number; entity: string; action: string; summary: string; detail: string; createdAt: string; actor?: string }[]>([]);
  const [packCount, setPackCount] = useState<number | ''>('');
  const [dropPublic, setDropPublic] = useState(false);
  const [reseatEachRound, setReseatEachRound] = useState(true);
  const [evenPackCount, setEvenPackCount] = useState(true);
  const [limitDeckbuilding, setLimitDeckbuilding] = useState(false);
  const [extraRatioEnabled, setExtraRatioEnabled] = useState(false);
  const [extraRatioPercent, setExtraRatioPercent] = useState(25);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [reserveInputs, setReserveInputs] = useState<Record<string, string>>({});
  const [hoveredEvent, setHoveredEvent] = useState<number | null>(null);
  const [formatForm, setFormatForm] = useState({ matchFormat: 'swiss', swissRoundCount: 3, playoffSize: 0 });
  const [createUsers, setCreateUsers] = useState<{ username: string; createdAt: string; active: number }[]>([]);
  const [createUsersLoaded, setCreateUsersLoaded] = useState(false);
  const [newCreateUsername, setNewCreateUsername] = useState('');
  const [issuedCreateToken, setIssuedCreateToken] = useState<{ username: string; token: string } | null>(null);

  useEffect(() => {
    if (!state) return;
    setFormatForm({
      matchFormat: String(state.config.matchFormat ?? 'swiss'),
      swissRoundCount: Number(state.config.swissRoundCount ?? 3),
      playoffSize: Number(state.config.playoffSize ?? 0),
    });
  }, [state?.id, state?.config.matchFormat, state?.config.swissRoundCount, state?.config.playoffSize]);

  useEffect(() => {
    setAdminToken(sessionStorage.getItem('yc_super_token') ?? '');
    setCreateUsername(sessionStorage.getItem('yc_create_username') ?? '');
    setCreateToken(sessionStorage.getItem('yc_create_token') ?? '');
  }, []);

  const saveCredentials = () => {
    if (adminToken) sessionStorage.setItem('yc_super_token', adminToken);
    else sessionStorage.removeItem('yc_super_token');
    if (createUsername) sessionStorage.setItem('yc_create_username', createUsername);
    else sessionStorage.removeItem('yc_create_username');
    if (createToken) sessionStorage.setItem('yc_create_token', createToken);
    else sessionStorage.removeItem('yc_create_token');
    // Do not retain the revoked per-tournament token from older builds.
    localStorage.removeItem('yc_admin_token');
  };

  const isSuperSession = adminToken.trim().length > 0;

  const adminFetch = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(adminToken
          ? { 'X-Admin-Token': encodeURIComponent(adminToken) }
          : createUsername && createToken
            ? {
                'X-Create-User': encodeURIComponent(createUsername),
                'X-Create-Token': encodeURIComponent(createToken),
              }
            : {}),
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(d.code ?? `${res.status}`) as Error & { details?: unknown };
      error.details = d.details;
      throw error;
    }
    return d;
  }, [adminToken, createUsername, createToken]);

  const load = useCallback(async () => {
    saveCredentials();
    // 竞态守卫：快速切换 tid 或轮询重叠时，旧请求的迟到响应不得覆盖新数据
    const seq = ++loadSeq.current;
    if (tid) {
      try {
        const s = await adminFetch(`/admin/t/${tid}/state`, 'POST');
        if (seq === loadSeq.current) setState(s);
      } catch (e: any) {
        if (seq !== loadSeq.current) return;
        setMsg(e.message === 'AUTH_REQUIRED' || e.message === 'FORBIDDEN' ? '凭据缺失或无权管理该比赛' : e.message);
        setState(null);
      }
    }
    try {
      const p = tid
        ? await adminFetch(`/admin/t/${tid}/pools`)
        : isSuperSession
          ? await adminFetch('/admin/pools')
          : { pools: [], canEdit: false };
      if (seq === loadSeq.current) {
        if (Array.isArray(p)) {
          setPools(p);
          setCanEditPools(true);
        } else {
          setPools(p.pools ?? []);
          setCanEditPools(p.canEdit === true);
        }
      }
    } catch {
      if (seq === loadSeq.current) {
        setPools([]);
        setCanEditPools(false);
      }
    }
    try {
      const t = await adminFetch(isSuperSession ? '/admin/tournaments' : '/admin/mine/tournaments');
      if (seq === loadSeq.current) setTournaments(t);
    } catch {
      if (seq === loadSeq.current) setTournaments([]);
    }
    try {
      const users = await adminFetch('/admin/create-users');
      if (seq === loadSeq.current) {
        setCreateUsers(users);
        setCreateUsersLoaded(true);
      }
    } catch {
      if (seq === loadSeq.current) {
        setCreateUsers([]);
        setCreateUsersLoaded(false);
      }
    }
    if (tid) {
      try {
        const ev = await adminFetch(`/admin/t/${tid}/events`);
        if (seq === loadSeq.current) setEvents(ev);
      } catch {
        if (seq === loadSeq.current) setEvents([]);
      }
    }
  }, [adminFetch, tid, isSuperSession, createUsername, createToken]);
  // act 等异步回调完成后要刷新的是"当前最新 tid"的数据，而非发起时刻的闭包
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, createUsername, createToken, tid]);

  // 切换比赛时关闭编辑态，避免上一场比赛的表单残留
  useEffect(() => {
    setEditing(false);
    setReserveInputs({});
    setHoveredEvent(null);
    setCanEditPools(false);
  }, [tid]);

  // 控制台轮询刷新（dev_docs/06 §6）
  useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    const t0 = performance.now();
    try {
      const d = await adminFetch(path, 'POST', body ?? {});
      showMsg(`${path} ok ${JSON.stringify(d).slice(0, 100)}（${Math.round(performance.now() - t0)} ms）`);
      await loadRef.current();
    } catch (e: any) {
      if (e.message === 'INSUFFICIENT_PACK_RATIO' && e.details) {
        const d = e.details as { extraRatioPercent?: number; requiredMain?: number; availableMain?: number; requiredExtra?: number; availableExtra?: number };
        showMsg(`按 ${d.extraRatioPercent ?? '?'}% 组包失败：主卡需要 ${d.requiredMain ?? '?'} 张（可用 ${d.availableMain ?? '?'}），额外卡需要 ${d.requiredExtra ?? '?'} 张（可用 ${d.availableExtra ?? '?'})`);
      } else {
        showMsg(`${path} -> ${e.message}（${Math.round(performance.now() - t0)} ms）`);
      }
    }
  };

  const saveFormat = async () => {
    if (!state) return;
    try {
      await adminFetch(`/admin/t/${state.id}/match-format`, 'PUT', formatForm);
      showMsg('赛制已保存');
      await loadRef.current();
    } catch (e: any) { showMsg(`赛制保存失败：${e.message}`); }
  };

  const enterMatches = async () => {
    if (!state) return;
    try {
      let result = await adminFetch(`/admin/t/${state.id}/phase`, 'POST', { status: 'matches', round: 1 });
      if (result.requires_confirmation) {
        const deckErrorText = (error: string) => error
          .replace(/^main below minimum/, '主卡组不足')
          .replace(/^main above maximum/, '主卡组超限')
          .replace(/^extra above maximum/, '额外卡组超限')
          .replace(/^side above maximum/, '副卡组超限')
          .replace(/^more than (\d+) copies of (\d+)/, '单卡 $2 超过 $1 份')
          .replace(/^card (\d+) not in picked pool/, '卡片 $1 不在已选卡池')
          .replace(/^extra-deck card (\d+) in main/, '额外卡 $1 位于主卡组');
        const details = (result.invalid_decks as { displayName: string; playerId: string; errors: string[] }[])
          .map((item) => `${item.displayName || item.playerId}: ${item.errors.map(deckErrorText).join('；')}`)
          .join('\n');
        const confirmed = window.confirm(`以下玩家卡组不合规：\n\n${details}\n\n确认进入对战后将随机修复超限区域；主卡组不足的玩家会被判 DSQ。是否继续？`);
        if (!confirmed) return;
        result = await adminFetch(`/admin/t/${state.id}/phase`, 'POST', { status: 'matches', round: 1, confirm_invalid_decks: true });
      }
      const repairs = (result.repairs ?? []) as { playerId: string; disqualified: boolean; movedToSide: number; returnedToPool: number }[];
      const dsq = repairs.filter((r) => r.disqualified).map((r) => r.playerId);
      showMsg(dsq.length ? `已进入对战；DSQ：${dsq.join('、')}` : '卡组检查通过，已进入对战');
      await loadRef.current();
    } catch (e: any) {
      showMsg(`进入对战失败：${e.message}`);
    }
  };

  const addReserve = async (playerId: string) => {
    if (!state) return;
    const seconds = Number(reserveInputs[playerId] ?? '');
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
      showMsg('请输入要增加的正整数秒数（最多 3600 秒）');
      return;
    }
    try {
      const result = await adminFetch(`/admin/t/${state.id}/players/${encodeURIComponent(playerId)}/reserve`, 'POST', { seconds });
      setReserveInputs((values) => ({ ...values, [playerId]: '' }));
      showMsg(`${playerId} 已增加 ${seconds} 秒保留时间（当前 ${Math.ceil(Number(result.reserveMs ?? 0) / 1000)} 秒）`);
      await loadRef.current();
    } catch (e: any) {
      showMsg(`增加保留时间失败：${e.message}`);
    }
  };

  const performRevert = async (seq: number) => {
    if (!state) return;
    try {
      const preview = await adminFetch(`/admin/t/${state.id}/revert/preview?seq=${seq}`) as {
        tournamentName: string;
        targetStatus: string;
        targetRound: number;
        deleteEvents: number;
        deletePicks: number;
        deleteMatches: number;
        closeRooms: string[];
      };
      const typed = window.prompt(
        `这是不可撤销的硬回溯：将删除 ${preview.deleteEvents} 条后续事件（含 ${preview.deletePicks} 次选牌、${preview.deleteMatches} 场对局），关闭 ${preview.closeRooms.length} 个房间，并恢复到 ${preview.targetStatus} r${preview.targetRound}。\n\n请输入比赛名称“${preview.tournamentName}”确认：`,
        '',
      );
      if (typed === null) return;
      if (typed !== preview.tournamentName) {
        showMsg('比赛名称不匹配，已取消回溯');
        return;
      }
      const result = await adminFetch(`/admin/t/${state.id}/revert`, 'POST', { seq, confirm_name: typed });
      const replacements = Object.entries(result.replacement_tokens ?? {}) as [string, string][];
      showMsg(replacements.length
        ? `回溯完成；${replacements.length} 个历史玩家缺少原凭据，已生成替换 token：${replacements.map(([p, t]) => `${p}=${t}`).join('，')}`
        : `回溯完成，已删除 ${result.deleted_events} 条后续事件；比赛保持冻结`);
      setSelectedSeq(null);
      await loadRef.current();
    } catch (e: any) {
      showMsg(`回溯失败：${e.message}`);
    }
  };

  const openEdit = () => {
    if (!state) return;
    setEditForm({
      name: state.name,
      mode: (state.config.mode as string) ?? 'match',
      maxPlayers: state.config.maxPlayers as number,
      packSize: (state.config.packSize as number) ?? ((state.config.packSizeMultiple as number) ?? 3) * (state.players.length || 2),
      cardPool: (state.config.cardPool as string) ?? '',
      mainMin: state.config.mainMin as number,
      mainMax: state.config.mainMax as number,
      extraMax: state.config.extraMax as number,
      sideMax: state.config.sideMax as number,
      maxCopies: (state.config.maxCopies as number) ?? 3,
      timeLimit: (state.config.timeLimit as number) ?? 180,
      pickSeconds: state.config.pickSeconds as number,
      reserveSeconds: (state.config.reserveSeconds as number) ?? 400,
      deckbuildingSeconds: (state.config.deckbuildingSeconds as number | null) ?? 600,
      packStrategy: (state.config.packStrategy as string) ?? 'stratify',
    });
    setPackCount((state.config.packCount as number | undefined) ?? '');
    setDropPublic((state.config.dropPublic as boolean | undefined) === true);
    setReseatEachRound((state.config.reseatEachRound as boolean | undefined) !== false);
    setEvenPackCount((state.config.evenPackCount as boolean | undefined) !== false);
    setLimitDeckbuilding(typeof state.config.deckbuildingSeconds === 'number' && Number(state.config.deckbuildingSeconds) > 0);
    const configuredExtraRatio = state.config.extraRatioPercent;
    setExtraRatioEnabled(typeof configuredExtraRatio === 'number');
    setExtraRatioPercent(typeof configuredExtraRatio === 'number' ? configuredExtraRatio : 25);
    setEditing(true);
  };

  const saveEdit = async () => {
    try {
      const body = {
        name: String(editForm.name),
        mode: String(editForm.mode === 'single' ? 'single' : 'match'),
        maxPlayers: Number(editForm.maxPlayers),
        packSize: Number(editForm.packSize),
        cardPool: String(editForm.cardPool),
        mainMin: Number(editForm.mainMin),
        mainMax: Number(editForm.mainMax),
        extraMax: Number(editForm.extraMax),
        sideMax: Number(editForm.sideMax),
        maxCopies: Number(editForm.maxCopies),
        timeLimit: Number(editForm.timeLimit),
        pickSeconds: Number(editForm.pickSeconds),
        reserveSeconds: Number(editForm.reserveSeconds ?? 400),
        deckbuildingSeconds: limitDeckbuilding ? Number(editForm.deckbuildingSeconds) : null,
        packStrategy: String(editForm.packStrategy === 'random' || editForm.packStrategy === 'main_then_extra' ? editForm.packStrategy : 'stratify'),
        extraRatioPercent: extraRatioEnabled ? extraRatioPercent : null,
        packCount: packCount === '' ? null : Number(packCount), // null = 恢复自动（后端删除该键语义）
        dropPublic,
        reseatEachRound,
        evenPackCount,
      };
      await adminFetch(`/admin/t/${state!.id}/config`, 'PUT', body);
      setMsg('参数已更新');
      setEditing(false);
      await load();
    } catch (e: any) {
      setMsg(e.message === 'WRONG_PHASE' ? '选牌开始后不能再修改参数' : e.message);
    }
  };

  const createPoolFromText = async () => {
    if (!poolCodes.trim()) {
      showMsg('请输入卡牌编号');
      return;
    }
    try {
      const d = await adminFetch('/admin/pools', 'POST', { name: poolName, importText: poolCodes });
      const report: PoolImportReport = { filtered: Number(d.filtered ?? 0), missingCodes: d.missingCodes ?? [], entryWarnings: d.entryWarnings ?? [] };
      setPoolReport(report);
      const warningCount = (report.entryWarnings?.length ?? 0) + report.filtered;
      showMsg(warningCount > 0 ? `卡池已创建，但发现 ${warningCount} 项警告；请查看下方导入报告` : `卡池已创建，共 ${d.count ?? d.codes?.length ?? 0} 张`);
      await load();
      if (warningCount === 0) setPoolCodes('');
    } catch (e: any) {
      if (e.message === 'BAD_POOL_IMPORT' && Array.isArray(e.details)) {
        setPoolReport({ filtered: 0, missingCodes: [], entryWarnings: e.details });
        showMsg('没有可导入的有效编号，请查看逐行警告');
        return;
      }
      showMsg(e.message === 'POOL_EXISTS' ? '卡池名称已存在' : e.message);
    }
  };

  const createRandomPool = async () => {
    try {
      const d = await adminFetch('/admin/pools/random', 'POST', { name: poolName, size: poolSize });
      setPoolReport({ filtered: Number(d.filtered ?? 0), missingCodes: d.missingCodes ?? [], entryWarnings: d.entryWarnings ?? [] });
      showMsg(d.filtered > 0 ? `随机卡池已创建，自动过滤 ${d.filtered} 张 token 卡` : '随机卡池已创建');
      await load();
    } catch (e: any) {
      showMsg(e.message);
    }
  };

  const createPermissionUser = async () => {
    const username = newCreateUsername.trim();
    if (!username) {
      showMsg('请输入权限用户名');
      return;
    }
    try {
      const result = await adminFetch('/admin/create-users', 'POST', { username });
      setIssuedCreateToken({ username: result.username, token: result.create_token });
      setNewCreateUsername('');
      showMsg(`权限用户 ${result.username} 已创建；token 只显示一次`);
      await loadRef.current();
    } catch (e: any) {
      showMsg(e.message === 'CREATE_USER_EXISTS' ? '该权限用户名已存在' : (e.message === 'BAD_CREATE_USERNAME' ? '用户名须为 1–32 位字母、数字、点、下划线或连字符' : e.message));
    }
  };

  const deletePermissionUser = async (username: string) => {
    if (!window.confirm(`立即撤销权限用户 ${username}？`)) return;
    try {
      await adminFetch(`/admin/create-users/${encodeURIComponent(username)}`, 'DELETE');
      if (issuedCreateToken?.username === username) setIssuedCreateToken(null);
      showMsg(`权限用户 ${username} 已删除`);
      await loadRef.current();
    } catch (e: any) {
      showMsg(`删除权限用户失败：${e.message}`);
    }
  };

  const deletePool = async (pool: PoolInfo) => {
    if (deletingPoolId !== null) return;
    if (!window.confirm(`确定删除卡池“${pool.name}”？删除后公开浏览链接将失效。`)) return;
    setDeletingPoolId(pool.id);
    try {
      await adminFetch(`/admin/pools/${pool.id}`, 'DELETE');
      showMsg(`卡池“${pool.name}”已删除`);
      await loadRef.current();
    } catch (e: any) {
      const details = e?.details as { tournaments?: { id: number; name: string; status: string }[] } | undefined;
      if (e?.message === 'POOL_IN_USE') {
        const names = details?.tournaments?.map((t) => `${t.name || `#${t.id}`}（${t.status}）`) ?? [];
        showMsg(names.length > 0
          ? `卡池仍被进行中的比赛使用：${names.join('、')}。请先结束比赛后再删除。`
          : '卡池仍被进行中的比赛使用，请先结束比赛后再删除。');
      } else if (e?.message === 'POOL_NOT_FOUND') {
        showMsg('卡池已不存在，列表将刷新');
        await loadRef.current();
      } else if (e?.message === 'FORBIDDEN' || e?.message === 'AUTH_REQUIRED') {
        showMsg('当前凭据没有删除卡池的权限，请使用超级管理员 token');
      } else {
        showMsg(`删除卡池失败：${e?.message ?? '未知错误'}`);
      }
    } finally {
      setDeletingPoolId(null);
    }
  };

  const rotatePermissionUser = async (username: string) => {
    if (!window.confirm(`重新生成 ${username} 的 token？旧 token 将立即失效。`)) return;
    try {
      const result = await adminFetch(`/admin/create-users/${encodeURIComponent(username)}/token`, 'POST', {});
      setIssuedCreateToken({ username: result.username, token: result.create_token });
      showMsg(`权限用户 ${username} 的旧 token 已失效；新 token 只显示一次`);
      await loadRef.current();
    } catch (e: any) {
      showMsg(`重生成 token 失败：${e.message}`);
    }
  };

  const editPlayers = Math.max(1, Number(editForm.maxPlayers) || 1);
  const editPackSize = Math.max(1, Number(editForm.packSize) || 24);
  const editPoolCount = pools.find((p) => p.name === String(editForm.cardPool ?? ''))?.count ?? 0;
  const editRawPacks = Math.max(1, Math.floor(editPoolCount / editPackSize));
  const editAutoPacks = evenPackCount && editRawPacks >= editPlayers ? editRawPacks - (editRawPacks % editPlayers) : editRawPacks;
  const editRequestedPacks = packCount === '' ? null : Number(packCount);
  const editCeilPacks = Math.max(1, Math.ceil(editPoolCount / editPackSize));
  const editCeilRounded = editCeilPacks - (editCeilPacks % editPlayers);
  const editOverLimitPacks = evenPackCount && editCeilRounded >= editPlayers ? editCeilRounded : editCeilPacks;
  const editEffectivePacks = editRequestedPacks === null
    ? editAutoPacks
    : editRequestedPacks > editRawPacks
      ? editOverLimitPacks
      : editRequestedPacks;
  const editDraftedCards = Math.min(editPoolCount, editEffectivePacks * editPackSize);
  const editCardsLow = Math.floor(editDraftedCards / editPlayers);
  const editCardsHigh = Math.ceil(editDraftedCards / editPlayers);
  const editExtraRatioInvalid = extraRatioEnabled && (!Number.isInteger(extraRatioPercent) || extraRatioPercent < 0 || extraRatioPercent > 100);
  const editExtraPerPack = extraRatioEnabled ? Math.round(editPackSize * extraRatioPercent / 100) : 0;
  const editMainPerPack = editPackSize - editExtraPerPack;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5">
        <p className="yc-kicker mb-1">Tournament operations</p>
        <h1 className="yc-title text-2xl font-bold">管理控制台</h1>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="w-full rounded bg-felt px-3 py-1.5 font-mono text-xs outline-none sm:w-72"
          placeholder="超级管理员 token（或填写下方创建者凭据）"
          type="password"
          value={adminToken}
          onChange={(e) => {
            setAdminToken(e.target.value);
            if (e.target.value) {
              setCreateUsername('');
              setCreateToken('');
            }
          }}
        />
        <input
          className="w-40 rounded bg-felt px-3 py-1.5 text-xs outline-none"
          placeholder="创建用户名"
          value={createUsername}
          onChange={(e) => {
            setCreateUsername(e.target.value);
            if (e.target.value) setAdminToken('');
          }}
        />
        <input
          className="w-full rounded bg-felt px-3 py-1.5 font-mono text-xs outline-none sm:w-64"
          placeholder="创建 token"
          type="password"
          value={createToken}
          onChange={(e) => {
            setCreateToken(e.target.value);
            if (e.target.value) setAdminToken('');
          }}
        />
        <input className="w-24 rounded bg-felt px-3 py-1.5 outline-none" placeholder="比赛 ID" value={tid} onChange={(e) => setTid(e.target.value)} />
        <button onClick={() => void load()} className="rounded bg-felt-edge px-4 py-1.5 hover:brightness-110">
          加载
        </button>
      </div>
      {createUsersLoaded && (
        <section className="mb-6 rounded-lg border border-gold/25 bg-felt/60 p-4 text-xs">
          <h2 className="mb-2 text-sm font-semibold text-gold">比赛创建权限用户</h2>
          <p className="mb-3 text-slate-400">创建 token 只保存哈希；新 token 仅在生成或重新生成时显示一次。</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-56 rounded bg-felt-deep px-2 py-1 outline-none ring-gold/50 focus:ring-2"
              placeholder="用户名（1–32 位）"
              value={newCreateUsername}
              onChange={(e) => setNewCreateUsername(e.target.value)}
            />
            <button onClick={() => void createPermissionUser()} className="rounded bg-gold px-3 py-1 font-semibold text-felt-deep hover:brightness-110">生成 token</button>
          </div>
          {issuedCreateToken && (
            <div className="mt-3 rounded border border-amber-300/30 bg-amber-950/30 p-2 text-amber-100">
              <span>{issuedCreateToken.username} token：</span>
              <code className="break-all font-mono text-gold">{issuedCreateToken.token}</code>
              <button onClick={() => void navigator.clipboard.writeText(issuedCreateToken.token)} className="ml-2 rounded bg-felt-edge px-2 py-0.5 hover:brightness-110">复制</button>
            </div>
          )}
          <ul className="mt-3 space-y-1">
            {createUsers.map((user) => (
              <li key={user.username} className="flex flex-wrap items-center justify-between gap-2 rounded bg-felt-deep/50 px-2 py-1">
                <span><b>{user.username}</b> · 创建于 {user.createdAt.slice(0, 10)}{user.active ? '' : ' · 已停用'}</span>
                <span className="flex gap-1">
                  <button onClick={() => void rotatePermissionUser(user.username)} className="rounded bg-felt-edge px-2 py-0.5 text-gold hover:brightness-110">重生成 token</button>
                  <button onClick={() => void deletePermissionUser(user.username)} className="rounded bg-red-900 px-2 py-0.5 text-red-100 hover:brightness-110">删除</button>
                </span>
              </li>
            ))}
            {createUsers.length === 0 && <li className="text-slate-500">暂无权限用户</li>}
          </ul>
        </section>
      )}
      {msg && (
        <div key={msgKey} className="fixed left-4 right-4 top-4 z-50 rounded-lg border border-felt-edge bg-felt px-3 py-2 text-xs text-slate-300 shadow-2xl sm:left-auto sm:max-w-sm">
          {msg}
        </div>
      )}
      {state && (
        <>
          <div className="mb-4 rounded-lg border border-felt-edge bg-felt p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-gold">{state.name}</b>
              <span className="rounded bg-felt-edge px-2 py-0.5 text-xs">{state.status} r{state.round}</span>
              <span className="text-xs text-slate-400">创建者：{state.createdBy ?? 'unknown'}</span>
              {state.frozen && <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-200">管理员冻结</span>}
              {state.status === 'registration' && (
                <button onClick={openEdit} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  编辑参数
                </button>
              )}
              <button onClick={() => void act(`/admin/t/${state.id}/start_draft`)} className="rounded bg-gold px-3 py-1 text-xs font-semibold text-felt-deep hover:brightness-110">
                开始选牌
              </button>
              <button
                onClick={() => void act(`/admin/t/${state.id}/phase`, { status: 'deckbuilding' })}
                disabled={state.pendingPhase === 'deckbuilding'}
                className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                进入构筑
              </button>
              {state.status === 'deckbuilding' && (
                <button onClick={() => void act(`/admin/t/${state.id}/phase`, { status: 'drafting' })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  回退到选牌
                </button>
              )}
              <button onClick={() => void enterMatches()} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                进入对战
              </button>
              <button onClick={() => void act(`/admin/t/${state.id}/matches/start`, { round: state.round || 1 })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                开始第 {state.round + 1} 轮
              </button>
              {state.frozen ? (
                <button onClick={() => void act(`/admin/t/${state.id}/resume`)} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  恢复
                </button>
              ) : null}
              <button
                onClick={() => {
                  const seq = window.prompt('回溯到事件序号 seq', '');
                  if (seq && /^\d+$/.test(seq)) void performRevert(Number(seq));
                }}
                className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110"
              >
                回溯
              </button>
              <label className="flex cursor-pointer items-center gap-2 text-xs" title="暂停整场比赛（玩家操作将被拦截）">
                <button
                  role="switch"
                  aria-checked={state.frozen}
                  onClick={() => void act(state.frozen ? `/admin/t/${state.id}/resume` : `/admin/t/${state.id}/pause`)}
                  className={`relative h-5 w-9 rounded-full transition ${state.frozen ? 'bg-red-700' : 'bg-felt-edge'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-felt-deep transition-all ${state.frozen ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <span className={state.frozen ? 'text-red-300' : 'text-slate-300'}>暂停中</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs" title="同机测试时可关闭玩家令牌校验">
                <button
                  role="switch"
                  aria-checked={state.authRequired}
                  onClick={() => void act(`/admin/t/${state.id}/security`, { require_token: !state.authRequired })}
                  className={`relative h-5 w-9 rounded-full transition ${state.authRequired ? 'bg-gold' : 'bg-felt-edge'}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-felt-deep transition-all ${state.authRequired ? 'left-[18px]' : 'left-0.5'}`}
                  />
                </button>
                <span className={state.authRequired ? 'text-slate-300' : 'text-slate-500'}>
                  令牌鉴权{state.authRequired ? '开启' : '关闭'}
                </span>
              </label>
            </div>
          </div>
          <section className="mb-4 rounded-lg border border-gold/25 bg-felt/60 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <b className="text-gold">赛制</b>
              <select disabled={state.matches.length > 0} className="rounded bg-felt-deep px-2 py-1 disabled:opacity-60" value={formatForm.matchFormat} onChange={(e) => setFormatForm((f) => ({ ...f, matchFormat: e.target.value }))}>
                <option value="round_robin">单循环</option><option value="swiss">瑞士轮</option><option value="double_elimination">双败淘汰</option>
              </select>
              {formatForm.matchFormat === 'swiss' && <>
                <label>轮数 <input disabled={state.matches.length > 0} type="number" min={1} className="w-14 rounded bg-felt-deep px-2 py-1" value={formatForm.swissRoundCount} onChange={(e) => setFormatForm((f) => ({ ...f, swissRoundCount: Number(e.target.value) }))} /></label>
                <label>淘汰人数 <select disabled={state.matches.length > 0} className="rounded bg-felt-deep px-2 py-1" value={formatForm.playoffSize} onChange={(e) => setFormatForm((f) => ({ ...f, playoffSize: Number(e.target.value) }))}>{[0,2,4,8,16,32,64].map((n) => <option key={n} value={n}>{n === 0 ? '无' : `Top ${n}`}</option>)}</select></label>
              </>}
              {state.matches.length === 0 ? <button onClick={() => void saveFormat()} className="rounded bg-gold px-3 py-1 font-semibold text-felt-deep">保存赛制</button> : <span className="text-slate-400">首轮已生成，赛制已锁定</span>}
            </div>
          </section>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
              <h3 className="mb-2 font-semibold text-gold">玩家</h3>
              {state.players.map((p) => (
                <div key={p.playerId} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                  <span>{p.displayName} ({p.playerId}) {p.eliminated && <b className="ml-1 rounded bg-red-900 px-1.5 py-0.5 text-red-100">DSQ</b>} {p.withdrawn && <b className="ml-1 rounded bg-amber-900 px-1.5 py-0.5 text-amber-100">退赛</b>}</span>
                  <span className="font-mono text-slate-400">
                    seat {p.seat} · {state.pickSummary.find((s) => s.playerId === p.playerId)?.count ?? 0} 选牌 · {p.eliminated ? 'DSQ' : state.decks[p.playerId]?.lockedAt ? '已锁定' : '构筑中'}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button onClick={() => void act(`/admin/t/${state.id}/players/${encodeURIComponent(p.playerId)}/${p.withdrawn ? 'restore' : 'withdraw'}`)} disabled={p.withdrawn && state.matches.length > 0} className="rounded bg-amber-900 px-1.5 py-0.5 text-amber-100 disabled:opacity-40">{p.withdrawn ? '恢复' : '退赛'}</button>
                    <button
                      onClick={async () => {
                        try {
                          const d = await adminFetch(`/admin/t/${state.id}/players/${encodeURIComponent(p.playerId)}/token`, 'POST', {});
                          setShownToken({ pid: p.playerId, token: d.token });
                        } catch (e: any) {
                          showMsg(e.message);
                        }
                      }}
                      className="rounded bg-felt-edge px-1.5 py-0.5 text-gold hover:brightness-110"
                      title="重置并显示玩家 token（每次点击生成新 token）"
                    >
                      token
                    </button>
                    <button
                      onClick={() => {
                        if (!confirm(`删除玩家 ${p.playerId}？（将清除其选牌与卡组）`)) return;
                        void adminFetch(`/admin/t/${state.id}/players/${encodeURIComponent(p.playerId)}`, 'DELETE').then(() => loadRef.current()).catch((e: any) => showMsg(`删除失败: ${e.message}`));
                      }}
                      className="rounded bg-red-900 px-1.5 py-0.5 text-red-100 hover:brightness-110"
                      title="删除玩家（报名/选牌/构筑阶段可用）"
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
              {shownToken && (
                <p className="mt-1 rounded bg-felt-deep px-2 py-1 font-mono text-gold">
                  {shownToken.pid} token: {shownToken.token}
                  <button
                    onClick={() => void navigator.clipboard.writeText(shownToken.token)}
                    className="ml-2 rounded bg-felt-edge px-1.5 py-0.5 hover:brightness-110"
                  >
                    复制
                  </button>
                </p>
              )}
              <div className="mt-2 flex gap-1">
                <input
                  className="w-32 rounded bg-felt-deep px-2 py-1 outline-none ring-gold/50 focus:ring-2"
                  placeholder="新玩家 ID"
                  value={addPid}
                  onChange={(e) => setAddPid(e.target.value)}
                />
                <button
                  onClick={() => {
                    const pid = addPid.trim();
                    if (!pid) return;
                    void act(`/admin/t/${state.id}/players`, { player_id: pid });
                    setAddPid('');
                  }}
                  className="rounded bg-gold px-2 py-1 font-semibold text-felt-deep hover:brightness-110"
                >
                  添加玩家
                </button>
              </div>
            </section>
            <section className="rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
              <h3 className="mb-2 font-semibold text-gold">当前选牌</h3>
              {state.pickCursor ? (
                <p className="font-mono">
                  pack {state.pickCursor.packIndex} r{state.pickCursor.round} → {state.pickCursor.playerId} until{' '}
                  {new Date(state.pickCursor.deadlineAt).toLocaleTimeString()}
                </p>
              ) : (
                <p className="text-slate-500">无进行中的选牌</p>
              )}
              {state.pause && (
                <p className="mt-1 text-red-300">暂停：管理员已暂停{state.pause.actor ? `（${state.pause.actor}）` : ''}，等待后台恢复</p>
              )}
              {state.pendingPhase === 'deckbuilding' && <p className="mt-1 text-amber-300">已请求进入构筑：等待当前轮结束（进度将保留）</p>}
            </section>
            <section className="rounded-lg border border-gold/25 bg-felt/60 p-3 text-xs">
              <h3 className="mb-1 font-semibold text-gold">保留时间调整</h3>
              <p className="mb-2 text-slate-400">选牌阶段可给指定玩家增加 reserve；不会刷新已消耗的时间。超时自动选择会优先使用该玩家最后点击的候选牌。</p>
              <div className="space-y-1.5">
                {state.players.map((p) => {
                  const reserveMs = state.pickReserves?.[p.playerId];
                  const alternative = state.pickAlternatives?.[p.playerId];
                  return (
                    <div key={p.playerId} className="flex flex-wrap items-center gap-2 rounded bg-felt-deep/50 px-2 py-1">
                      <span className="min-w-[6rem] flex-1 truncate">{p.displayName || p.playerId}</span>
                      <span className="font-mono text-amber-200">{reserveMs === undefined ? '—' : `${Math.ceil(reserveMs / 1000)} 秒`}</span>
                      {alternative && <span className="text-slate-400">候选 #{alternative.card}</span>}
                      <input
                        aria-label={`给 ${p.playerId} 增加保留秒数`}
                        type="number"
                        min={1}
                        max={3600}
                        placeholder="秒数"
                        className="w-16 rounded bg-felt-deep px-1.5 py-0.5 text-center"
                        value={reserveInputs[p.playerId] ?? ''}
                        onChange={(e) => setReserveInputs((values) => ({ ...values, [p.playerId]: e.target.value }))}
                      />
                      <button
                        onClick={() => void addReserve(p.playerId)}
                        disabled={state.status !== 'drafting' || state.frozen}
                        className="rounded bg-gold px-2 py-0.5 font-semibold text-felt-deep hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        增加秒数
                      </button>
                    </div>
                  );
                })}
              </div>
              {state.status !== 'drafting' && <p className="mt-2 text-slate-500">当前不在选牌阶段，调整按钮已禁用。</p>}
            </section>
            <section className="rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
              <h3 className="mb-2 font-semibold text-gold">事件时间线（点击选择回溯点）</h3>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {events.map((e) => (
                  <div
                    key={e.seq}
                    onClick={() => { setSelectedSeq(e.seq); setHoveredEvent(e.seq); }}
                    onMouseEnter={() => setHoveredEvent(e.seq)}
                    onMouseLeave={() => setHoveredEvent(null)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-felt-deep ${
                      selectedSeq === e.seq ? 'bg-gold/20 ring-1 ring-gold' : ''
                    }`}
                    title={e.detail}
                  >
                    <span className="w-14 shrink-0 font-mono text-slate-400">{e.seq}</span>
                    <span className="w-16 shrink-0 font-mono text-slate-500">{new Date(e.createdAt).toLocaleTimeString()}</span>
                    <span className="truncate">{e.summary}</span>
                    {e.actor && <span className="shrink-0 text-slate-500">· {e.actor}</span>}
                  </div>
                ))}
                {events.length === 0 && <p className="py-2 text-center text-slate-500">暂无事件</p>}
              </div>
              {(() => {
                const detailSeq = hoveredEvent ?? selectedSeq;
                const detail = events.find((e) => e.seq === detailSeq)?.detail;
                return detail ? <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded bg-felt-deep/70 p-2 font-mono text-[0.625rem] leading-relaxed text-slate-300">{detail}</pre> : null;
              })()}
              <div className="mt-2 flex items-center gap-2">
                <span className="font-mono text-gold">{selectedSeq !== null ? `seq ${selectedSeq}` : '未选择'}</span>
                <button
                  onClick={() => {
                    if (selectedSeq === null) return;
                    void performRevert(selectedSeq);
                  }}
                  disabled={selectedSeq === null}
                  className="rounded bg-gold px-2 py-1 font-semibold text-felt-deep hover:brightness-110 disabled:opacity-40"
                >
                  回溯到此
                </button>
              </div>
            </section>
          </div>
          <section className="mt-4 rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
            <h3 className="mb-2 font-semibold text-gold">对阵</h3>
            {state.matches.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-0.5 font-mono">
                <span>{m.stage ? `${m.stage} ` : ''}r{m.round} t{m.tableNo ?? m.id}</span>
                <span className="truncate">{m.playerA} vs {m.playerB}</span>
                <span className="truncate">{m.roomName ?? '-'}</span>
                {m.faultedAt && m.resultA === null && (
                  <span className="rounded bg-red-900 px-1.5 py-0.5 text-red-100" title={`房间故障退出（${new Date(m.faultedAt).toLocaleString()}），请手动补录结果`}>
                    故障
                  </span>
                )}
                <span>{m.resultA !== null ? `${m.resultA}:${m.resultB}` : '对局中'}</span>
                <span className="flex shrink-0 gap-1">
                  <input
                    type="number"
                    min={0}
                    max={2}
                    className="w-10 rounded bg-felt-deep px-1 py-0.5 text-center outline-none"
                    placeholder="A"
                    value={matchInputs[m.id]?.a ?? ''}
                    onChange={(e) => setMatchInputs((s) => ({ ...s, [m.id]: { a: e.target.value, b: s[m.id]?.b ?? '' } }))}
                  />
                  :
                  <input
                    type="number"
                    min={0}
                    max={2}
                    className="w-10 rounded bg-felt-deep px-1 py-0.5 text-center outline-none"
                    placeholder="B"
                    value={matchInputs[m.id]?.b ?? ''}
                    onChange={(e) => setMatchInputs((s) => ({ ...s, [m.id]: { a: s[m.id]?.a ?? '', b: e.target.value } }))}
                  />
                  <button
                    onClick={() => {
                      const v = matchInputs[m.id];
                      if (!v || v.a === '' || v.b === '') return;
                      void act(`/admin/t/${state.id}/match/result`, { round: m.round, tableNo: m.tableNo, resultA: Number(v.a), resultB: Number(v.b) });
                      setMatchInputs((s) => ({ ...s, [m.id]: { a: '', b: '' } }));
                    }}
                    className="rounded bg-gold px-1.5 py-0.5 font-semibold text-felt-deep hover:brightness-110"
                    title="手动设置/修改该对局结果（立即更新积分与轮次推进）"
                  >
                    设结果
                  </button>
                </span>
              </div>
            ))}
            {state.matches.length === 0 && <p className="text-slate-500">暂无对阵</p>}
            {state.status === 'matches' &&
              state.matches.some((m) => m.round === state.round) &&
              state.matches.every((m) => m.round !== state.round || (m.resultA !== null && m.resultB !== null)) &&
              !state.matches.some((m) => m.round === state.round + 1) && (
                <button
                  onClick={() => void act(`/admin/t/${state.id}/matches/advance`)}
                  className="mt-2 w-full rounded bg-gold px-3 py-1.5 font-semibold text-felt-deep hover:brightness-110"
                >
                  确认本轮结果，开始第 {state.round + 1} 轮
                </button>
              )}
          </section>
        </>
      )}

      {editing && state && (
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60" onClick={() => setEditing(false)}>
          <div className="mx-4 max-h-[90vh] w-[780px] max-w-[94vw] overflow-y-auto rounded-lg border border-felt-edge bg-felt p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-semibold text-gold">编辑比赛参数（仅报名阶段）</h3>
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <label className="col-span-full flex items-center gap-2">
                名称
                <input className="flex-1 rounded bg-felt-deep px-2 py-1" value={String(editForm.name ?? '')} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
              </label>
              <label className="flex items-center gap-2">人数 <input type="number" min={2} max={64} className="w-16 rounded bg-felt-deep px-2 py-1" value={Number(editForm.maxPlayers) || 2} onChange={(e) => setEditForm((f) => ({ ...f, maxPlayers: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">模式
                <select className="rounded bg-felt-deep px-2 py-1" value={String(editForm.mode ?? 'match')} onChange={(e) => setEditForm((f) => ({ ...f, mode: e.target.value }))}>
                  <option value="match">BO3 对战</option>
                  <option value="single">单局</option>
                </select>
              </label>
              <label className="flex items-center gap-2">每堆卡数 <input type="number" min={1} max={60} className="w-14 rounded bg-felt-deep px-2 py-1" value={Number(editForm.packSize) || 24} onChange={(e) => setEditForm((f) => ({ ...f, packSize: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">牌堆总数（轮数）
                <input type="number" min={1} className="w-14 rounded bg-felt-deep px-2 py-1" placeholder="自动" value={packCount} onChange={(e) => setPackCount(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))} />
                {evenPackCount && packCount !== '' && Number(packCount) % (Number(editForm.maxPlayers) || 2) !== 0 && <span className="text-red-300">须为人数整数倍</span>}
              </label>
              <div className="col-span-full rounded border border-emerald-300/20 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100">
                每位玩家可获得：{editCardsLow === editCardsHigh ? <b className="text-gold">{editCardsLow} 张</b> : <b className="text-amber-300">{editCardsLow}–{editCardsHigh} 张</b>}（实际使用 {editDraftedCards} 张）
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={evenPackCount} onChange={(e) => setEvenPackCount(e.target.checked)} /> 牌堆数为人数整数倍</label>
              <label className="flex items-center gap-2">保留时间（秒） <input type="number" min={0} max={3600} className="w-16 rounded bg-felt-deep px-2 py-1" value={Number(editForm.reserveSeconds) ?? 400} onChange={(e) => setEditForm((f) => ({ ...f, reserveSeconds: Math.max(0, Number(e.target.value)) }))} /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={dropPublic} onChange={(e) => setDropPublic(e.target.checked)} /> 公开被丢弃的卡牌</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={reseatEachRound} onChange={(e) => setReseatEachRound(e.target.checked)} /> 每轮结束后随机重排玩家座位</label>
              <label className="flex items-center gap-2">卡池
                <select className="rounded bg-felt-deep px-2 py-1" value={String(editForm.cardPool ?? '')} onChange={(e) => setEditForm((f) => ({ ...f, cardPool: e.target.value }))}>
                  {pools.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.count})</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2">主卡组 <input type="number" className="w-12 rounded bg-felt-deep px-1 py-1" value={Number(editForm.mainMin)} onChange={(e) => setEditForm((f) => ({ ...f, mainMin: Number(e.target.value) }))} />-<input type="number" className="w-12 rounded bg-felt-deep px-1 py-1" value={Number(editForm.mainMax)} onChange={(e) => setEditForm((f) => ({ ...f, mainMax: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">额外上限 <input type="number" className="w-14 rounded bg-felt-deep px-1 py-1" value={Number(editForm.extraMax)} onChange={(e) => setEditForm((f) => ({ ...f, extraMax: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">副卡组上限 <input type="number" className="w-14 rounded bg-felt-deep px-1 py-1" value={Number(editForm.sideMax)} onChange={(e) => setEditForm((f) => ({ ...f, sideMax: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">单卡上限 <input type="number" min={1} max={3} className="w-14 rounded bg-felt-deep px-1 py-1" value={Number(editForm.maxCopies ?? 3)} onChange={(e) => setEditForm((f) => ({ ...f, maxCopies: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">回合限时 <input type="number" min={60} max={999} className="w-16 rounded bg-felt-deep px-1 py-1" value={Number(editForm.timeLimit ?? 180)} onChange={(e) => setEditForm((f) => ({ ...f, timeLimit: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">选牌秒数 <input type="number" className="w-16 rounded bg-felt-deep px-1 py-1" value={Number(editForm.pickSeconds)} onChange={(e) => setEditForm((f) => ({ ...f, pickSeconds: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={limitDeckbuilding} onChange={(e) => setLimitDeckbuilding(e.target.checked)} /> 限制构筑时间 {limitDeckbuilding ? <><input type="number" min={30} max={7200} className="w-16 rounded bg-felt-deep px-1 py-1" value={Number(editForm.deckbuildingSeconds)} onChange={(e) => setEditForm((f) => ({ ...f, deckbuildingSeconds: Number(e.target.value) }))} /> 秒</> : <span className="text-slate-400">无限</span>}</label>
              <label className="flex items-center gap-2">卡堆组成
                <select className="rounded bg-felt-deep px-1 py-1 disabled:cursor-not-allowed disabled:opacity-50" disabled={extraRatioEnabled} value={String(editForm.packStrategy ?? 'stratify')} onChange={(e) => setEditForm((f) => ({ ...f, packStrategy: e.target.value }))}>
                  <option value="stratify">主卡/额外卡按比例均匀每堆</option>
                  <option value="random">全随机</option>
                  <option value="main_then_extra">先全主卡再全额外</option>
                </select>
                {extraRatioEnabled && <span className="text-xs text-amber-200">比例配置优先</span>}
              </label>
              <label className="col-span-full flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={extraRatioEnabled} onChange={(e) => setExtraRatioEnabled(e.target.checked)} />
                按比例配置额外卡
                {extraRatioEnabled && <>
                  <input type="number" min={0} max={100} step={1} className="w-16 rounded bg-felt-deep px-2 py-1" value={extraRatioPercent} onChange={(e) => setExtraRatioPercent(e.target.value === '' ? 0 : Number(e.target.value))} />
                  <span>%（每个完整牌堆 {editMainPerPack} 主卡 + {editExtraPerPack} 额外卡）</span>
                </>}
                {editExtraRatioInvalid && <span className="text-xs text-red-300">比例必须是 0–100 的整数</span>}
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setEditing(false)} className="rounded px-4 py-1.5 text-slate-300 hover:bg-felt-edge">取消</button>
              <button onClick={() => void saveEdit()} disabled={editExtraRatioInvalid} className="rounded bg-gold px-4 py-1.5 font-semibold text-felt-deep hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      <section className="mt-6 rounded-lg border border-felt-edge bg-felt/60 p-4">
        <h2 className="mb-2 text-sm font-semibold text-gold">比赛列表</h2>
        <ul className="space-y-1 text-xs">
          {tournaments.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-felt-deep/50 px-2 py-1">
              <span>
                <b>{t.name}</b> · {t.status} r{t.round} · {t.player_count} 人 · 创建者 {t.created_by ?? 'unknown'}{t.frozen ? ' · 已暂停' : ''}
              </span>
              <span className="flex items-center gap-2">
                <button
                  onClick={() => { setTid(String(t.id)); }}
                  className="rounded bg-felt-edge px-2 py-0.5 hover:brightness-110"
                >
                  打开
                </button>
                <button
                  onClick={() => void act(t.frozen ? `/admin/t/${t.id}/resume` : `/admin/t/${t.id}/pause`)}
                  className={`rounded px-2 py-0.5 ${t.frozen ? 'bg-red-900 text-red-100' : 'bg-felt-edge'} hover:brightness-110`}
                >
                  {t.frozen ? '暂停中' : '暂停'}
                </button>
                {isSuperSession && <button
                  onClick={() => {
                    if (!confirm('确定删除该比赛？将对局房间关闭并清除全部数据')) return;
                    adminFetch(`/admin/t/${t.id}`, 'DELETE')
                      .then(() => { setMsg('比赛已删除'); if (tid === String(t.id)) { setTid(''); setState(null); } void load(); })
                      .catch((e: any) => setMsg(e.message));
                  }}
                  className="rounded bg-red-900 px-2 py-0.5 text-red-100 hover:brightness-110"
                >
                  删除
                </button>}
              </span>
            </li>
          ))}
          {tournaments.length === 0 && <li className="text-slate-500">暂无比赛（需要超级管理员令牌）</li>}
        </ul>
      </section>

      <section className="mt-6 rounded-lg border border-felt-edge bg-felt/60 p-4">
        <h2 className="mb-2 flex items-center justify-between text-sm font-semibold text-gold">
          <span>卡池管理</span>
          {canEditPools && (
            <a href="/admin/pool/new" className="rounded bg-gold px-3 py-1 text-xs font-semibold text-felt-deep hover:brightness-110">
              新建卡池
            </a>
          )}
        </h2>
        {canEditPools && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <input className="w-40 rounded bg-felt-deep px-2 py-1 outline-none" placeholder="卡池名称" value={poolName} onChange={(e) => setPoolName(e.target.value)} />
            <textarea
              className="h-10 w-64 rounded bg-felt-deep px-2 py-1 outline-none"
              placeholder="每行：code 或 code<TAB>卡名"
              value={poolCodes}
              onChange={(e) => setPoolCodes(e.target.value)}
            />
            <button onClick={createPoolFromText} className="rounded bg-felt-edge px-3 py-1 hover:brightness-110">
              按编号创建
            </button>
            <input type="number" className="w-20 rounded bg-felt-deep px-2 py-1" value={poolSize} onChange={(e) => setPoolSize(Number(e.target.value))} />
            <button onClick={createRandomPool} className="rounded bg-felt-edge px-3 py-1 hover:brightness-110">
              从全卡表随机采样
            </button>
          </div>
        )}
        {!canEditPools && <p className="mb-3 text-xs text-slate-400">创建者凭据只能读取卡池，不能编辑或删除。</p>}
        {poolReport && (poolReport.filtered > 0 || poolReport.missingCodes.length > 0 || (poolReport.invalidEntries?.length ?? 0) > 0 || (poolReport.entryWarnings?.length ?? 0) > 0) && (
          <div className="yc-notice mb-3 p-3 text-xs leading-5" role="alert">
            <div className="mb-1 flex items-center justify-between gap-3">
              <b>卡池导入警告</b>
              <button onClick={() => setPoolReport(null)} className="rounded px-1.5 text-amber-100/70 hover:bg-amber-100/10" aria-label="关闭导入报告">×</button>
            </div>
            {poolReport.missingCodes.length > 0 && (
              <p>卡表中找不到 {poolReport.missingCodes.length} 个编号，已跳过：<code className="break-all font-mono text-amber-100">{poolReport.missingCodes.join(', ')}</code></p>
            )}
            {(poolReport.invalidEntries?.length ?? 0) > 0 && (
              <p>无法解析 {poolReport.invalidEntries!.length} 项输入：<code className="break-all font-mono text-amber-100">{poolReport.invalidEntries!.join(', ')}</code></p>
            )}
            {(poolReport.entryWarnings?.length ?? 0) > 0 && (
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono text-amber-100">
                {poolReport.entryWarnings!.map((warning, index) => (
                  <li key={`${warning.line}-${index}`}>
                    第 {warning.line} 行：{warning.kind === 'invalid'
                      ? `格式无效（${warning.input}）`
                      : warning.kind === 'missing_code'
                        ? `找不到编号 ${warning.code}`
                        : `编号 ${warning.code} 的卡名应为“${warning.actualName}”，输入为“${warning.submittedName}”`}
                  </li>
                ))}
              </ul>
            )}
            {poolReport.filtered > 0 && <p>{poolReport.filtered} 张 token 卡不允许进入卡池，已过滤。</p>}
          </div>
        )}
        <ul className="space-y-1 text-xs">
          {pools.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-felt-deep/50 px-2 py-1">
              <span>
                <b>{p.name}</b>{p.isDefault && <span className="ml-2 rounded bg-gold px-1.5 py-0.5 text-[0.625rem] text-felt-deep">默认</span>} · {p.count} 张卡 · {p.createdAt.slice(0, 10)}
              </span>
              <span className="flex items-center gap-2">
                {canEditPools && !p.isDefault && (
                  <button
                    onClick={() => {
                      adminFetch('/admin/settings/default-pool', 'PUT', { pool_id: p.id })
                        .then(() => { showMsg(`默认卡池已设为 ${p.name}`); void load(); })
                        .catch((e: any) => showMsg(e.message));
                    }}
                    className="rounded bg-felt-edge px-2 py-0.5 text-emerald-100 hover:brightness-110"
                  >
                    设为默认
                  </button>
                )}
                {canEditPools && (
                  <a href={`/admin/pool/${p.id}`} className="rounded bg-felt-edge px-2 py-0.5 text-slate-200 hover:brightness-110">
                    编辑
                  </a>
                )}
                {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="rounded bg-felt-edge px-2 py-0.5 text-emerald-200 hover:brightness-110">公开查看</a>}
                {canEditPools && (
                  <button
                    onClick={() => void deletePool(p)}
                    disabled={deletingPoolId !== null}
                    className="rounded bg-red-900 px-2 py-0.5 text-red-100 hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                  >
                    {deletingPoolId === p.id ? '删除中…' : '删除'}
                  </button>
                )}
              </span>
            </li>
          ))}
          {pools.length === 0 && <li className="text-slate-500">暂无卡池（需要超级管理员令牌）</li>}
        </ul>
      </section>
    </main>
  );
}
