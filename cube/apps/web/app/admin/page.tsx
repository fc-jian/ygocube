'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface AdminState {
  id: number;
  name: string;
  status: string;
  round: number;
  frozen: boolean;
  authRequired: boolean;
  config: Record<string, unknown>;
  players: { playerId: string; displayName: string; seat: number }[];
  packs: { index: number; size: number; dropCard: number | null; order: number[] }[];
  picks: { playerId: string; packIndex: number; round: number; card: number; auto: boolean }[];
  pickCursor: { packIndex: number; round: number; playerId: string; deadlineAt: string } | null;
  pendingPhase: string | null;
  pause: { pausedAt: string | null; proposer: string | null } | null;
  decks: Record<string, { main: number[]; extra: number[]; side: number[]; lockedAt: string | null }>;
  matches: { id: number; round: number; playerA: string; playerB: string; tableNo: number; roomName: string | null; resultA: number | null; resultB: number | null; faultedAt: string | null }[];
  pickSummary: { playerId: string; seat: number; count: number }[];
}

interface PoolInfo {
  id: number;
  name: string;
  count: number;
  createdAt: string;
}

interface TournamentBrief {
  id: number;
  name: string;
  status: string;
  round: number;
  player_count: number;
  frozen: number;
  created_at: string;
}

export default function AdminPage() {
  const [adminToken, setAdminToken] = useState('');
  const [tid, setTid] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [poolName, setPoolName] = useState('');
  const [poolCodes, setPoolCodes] = useState('');
  const [poolSize, setPoolSize] = useState(1000);
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
  const [events, setEvents] = useState<{ seq: number; entity: string; action: string; summary: string; createdAt: string }[]>([]);
  const [packCount, setPackCount] = useState<number | ''>('');
  const [dropPublic, setDropPublic] = useState(true);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  useEffect(() => {
    setAdminToken(localStorage.getItem('yc_admin_token') ?? '');
  }, []);

  const saveToken = () => localStorage.setItem('yc_admin_token', adminToken);

  const adminFetch = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { ...(adminToken ? { 'X-Admin-Token': encodeURIComponent(adminToken) } : {}), 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.code ?? `${res.status}`);
    return d;
  }, [adminToken]);

  const load = useCallback(async () => {
    saveToken();
    // 竞态守卫：快速切换 tid 或轮询重叠时，旧请求的迟到响应不得覆盖新数据
    const seq = ++loadSeq.current;
    if (tid) {
      try {
        const s = await adminFetch(`/admin/t/${tid}/state`, 'POST');
        if (seq === loadSeq.current) setState(s);
      } catch (e: any) {
        if (seq !== loadSeq.current) return;
        setMsg(e.message === 'AUTH_REQUIRED' ? '管理令牌缺失或无权管理该比赛' : e.message);
        setState(null);
      }
    }
    try {
      const p = await adminFetch('/admin/pools');
      if (seq === loadSeq.current) setPools(p);
    } catch {
      if (seq === loadSeq.current) setPools([]);
    }
    try {
      const t = await adminFetch('/admin/tournaments');
      if (seq === loadSeq.current) setTournaments(t);
    } catch {
      if (seq === loadSeq.current) setTournaments([]);
    }
    if (tid) {
      try {
        const ev = await adminFetch(`/admin/t/${tid}/events`);
        if (seq === loadSeq.current) setEvents(ev);
      } catch {
        if (seq === loadSeq.current) setEvents([]);
      }
    }
  }, [adminFetch, tid]);
  // act 等异步回调完成后要刷新的是"当前最新 tid"的数据，而非发起时刻的闭包
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, tid]);

  // 切换比赛时关闭编辑态，避免上一场比赛的表单残留
  useEffect(() => {
    setEditing(false);
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
      showMsg(`${path} -> ${e.message}（${Math.round(performance.now() - t0)} ms）`);
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
      deckbuildingSeconds: state.config.deckbuildingSeconds as number,
      dropMode: (state.config.dropMode as string) ?? (state.config.dropLeftover === false ? 'use_all' : 'drop_leftover_exact'),
      packStrategy: (state.config.packStrategy as string) ?? 'stratify',
    });
    setPackCount((state.config.packCount as number | undefined) ?? '');
    setDropPublic((state.config.dropPublic as boolean | undefined) !== false);
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
        deckbuildingSeconds: Number(editForm.deckbuildingSeconds),
        dropMode: String(editForm.dropMode === 'use_all' || editForm.dropMode === 'drop_leftover_exact' ? editForm.dropMode : 'drop_leftover'),
        packStrategy: String(editForm.packStrategy === 'random' || editForm.packStrategy === 'main_then_extra' ? editForm.packStrategy : 'stratify'),
        packCount: packCount === '' ? undefined : Number(packCount),
        dropPublic,
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
    const codes = poolCodes.split(/[\s,，]+/).map(Number).filter(Number.isInteger);
    if (!codes.length) {
      setMsg('未识别到有效卡牌编号');
      return;
    }
    try {
      const d = await adminFetch('/admin/pools', 'POST', { name: poolName, codes });
      setMsg(d.filtered > 0 ? `卡池已创建，自动过滤 ${d.filtered} 张 token 卡` : '卡池已创建');
      await load();
    } catch (e: any) {
      setMsg(e.message === 'POOL_EXISTS' ? '卡池名称已存在' : e.message);
    }
    setPoolCodes('');
  };

  const createRandomPool = async () => {
    try {
      const d = await adminFetch('/admin/pools/random', 'POST', { name: poolName, size: poolSize });
      setMsg(d.filtered > 0 ? `随机卡池已创建，自动过滤 ${d.filtered} 张 token 卡` : '随机卡池已创建');
      await load();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-xl font-bold text-gold">管理控制台</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="w-72 rounded bg-felt px-3 py-1.5 font-mono text-xs outline-none"
          placeholder="管理令牌"
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
        />
        <input className="w-24 rounded bg-felt px-3 py-1.5 outline-none" placeholder="比赛 ID" value={tid} onChange={(e) => setTid(e.target.value)} />
        <button onClick={() => void load()} className="rounded bg-felt-edge px-4 py-1.5 hover:brightness-110">
          加载
        </button>
      </div>
      {msg && (
        <div key={msgKey} className="fixed right-4 top-4 z-50 max-w-sm rounded-lg border border-felt-edge bg-felt px-3 py-2 text-xs text-slate-300 shadow-2xl">
          {msg}
        </div>
      )}
      {state && (
        <>
          <div className="mb-4 rounded-lg border border-felt-edge bg-felt p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-gold">{state.name}</b>
              <span className="rounded bg-felt-edge px-2 py-0.5 text-xs">{state.status} r{state.round}</span>
              {state.frozen && <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-200">管理员冻结</span>}
              {state.status === 'registration' && (
                <button onClick={openEdit} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  编辑参数
                </button>
              )}
              <button onClick={() => void act(`/admin/t/${state.id}/start_draft`)} className="rounded bg-gold px-3 py-1 text-xs font-semibold text-felt-deep hover:brightness-110">
                开始选牌
              </button>
              <button onClick={() => void act(`/admin/t/${state.id}/phase`, { status: 'deckbuilding' })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                进入构筑
              </button>
              {state.status === 'deckbuilding' && (
                <button onClick={() => void act(`/admin/t/${state.id}/phase`, { status: 'drafting' })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  回退到选牌
                </button>
              )}
              <button onClick={() => void act(`/admin/t/${state.id}/phase`, { status: 'matches', round: 1 })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                进入对战
              </button>
              <button onClick={() => void act(`/admin/t/${state.id}/matches/start`, { round: state.round || 1 })} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                开始第 {state.round + 1} 轮
              </button>
              {state.pause?.pausedAt ? (
                <button onClick={() => void act(`/admin/t/${state.id}/pause/resume`)} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                  恢复
                </button>
              ) : null}
              <button
                onClick={() => {
                  const seq = window.prompt('回溯到事件序号 seq（回溯后比赛将冻结）', '');
                  if (seq && /^\d+$/.test(seq)) void act(`/admin/t/${state.id}/revert`, { seq: Number(seq) });
                }}
                className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110"
              >
                回溯
              </button>
              <label className="flex cursor-pointer items-center gap-2 text-xs" title="暂停整场比赛（玩家操作将被拦截）">
                <button
                  role="switch"
                  aria-checked={state.frozen}
                  onClick={() => void act(state.frozen ? `/admin/t/${state.id}/unfreeze` : `/admin/t/${state.id}/pause`)}
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
          <div className="grid grid-cols-2 gap-4">
            <section className="rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
              <h3 className="mb-2 font-semibold text-gold">玩家</h3>
              {state.players.map((p) => (
                <div key={p.playerId} className="flex items-center justify-between gap-2 py-0.5">
                  <span>{p.displayName} ({p.playerId})</span>
                  <span className="font-mono text-slate-400">
                    seat {p.seat} · {state.pickSummary.find((s) => s.playerId === p.playerId)?.count ?? 0} 选牌 · {state.decks[p.playerId]?.lockedAt ? '已锁定' : '构筑中'}
                  </span>
                  <span className="flex shrink-0 gap-1">
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
                <p className="mt-1 text-red-300">暂停：{state.pause.pausedAt ? '已暂停' : '投票中'}（发起人 {state.pause.proposer}）</p>
              )}
              {state.pendingPhase === 'deckbuilding' && <p className="mt-1 text-amber-300">等待当前牌堆选完后进入构筑（进度将保留）</p>}
            </section>
            <section className="rounded-lg border border-felt-edge bg-felt/60 p-3 text-xs">
              <h3 className="mb-2 font-semibold text-gold">事件时间线（点击选择回溯点）</h3>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {events.map((e) => (
                  <div
                    key={e.seq}
                    onClick={() => setSelectedSeq(e.seq)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-felt-deep ${
                      selectedSeq === e.seq ? 'bg-gold/20 ring-1 ring-gold' : ''
                    }`}
                    title={`${e.action}（${e.entity}）`}
                  >
                    <span className="w-14 shrink-0 font-mono text-slate-400">{e.seq}</span>
                    <span className="w-16 shrink-0 font-mono text-slate-500">{new Date(e.createdAt).toLocaleTimeString()}</span>
                    <span className="truncate">{e.summary}</span>
                  </div>
                ))}
                {events.length === 0 && <p className="py-2 text-center text-slate-500">暂无事件</p>}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="font-mono text-gold">{selectedSeq !== null ? `seq ${selectedSeq}` : '未选择'}</span>
                <button
                  onClick={() => {
                    if (selectedSeq === null) return;
                    if (!confirm(`回溯到事件 ${selectedSeq}？比赛将冻结，之后的进度全部回退`)) return;
                    void act(`/admin/t/${state.id}/revert`, { seq: selectedSeq });
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
              <div key={m.id} className="flex items-center justify-between gap-2 py-0.5 font-mono">
                <span>r{m.round} t{m.tableNo ?? m.id}</span>
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
          </section>
        </>
      )}

      {editing && state && (
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60" onClick={() => setEditing(false)}>
          <div className="w-[780px] max-w-[94vw] rounded-lg border border-felt-edge bg-felt p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-semibold text-gold">编辑比赛参数（仅报名阶段）</h3>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <label className="col-span-3 flex items-center gap-2">
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
              <label className="flex items-center gap-2">每堆卡数 <input type="number" min={1} max={60} className="w-14 rounded bg-felt-deep px-2 py-1" value={Number(editForm.packSize) || 12} onChange={(e) => setEditForm((f) => ({ ...f, packSize: Number(e.target.value) }))} />{Number(editForm.packSize) % (Number(editForm.maxPlayers) || 2) !== 0 && <span className="text-amber-300">非人数整数倍：每堆随机起始玩家</span>}</label>
              <label className="flex items-center gap-2">牌堆总数（轮数）
                <input type="number" min={1} className="w-14 rounded bg-felt-deep px-2 py-1" placeholder="自动" value={packCount} onChange={(e) => setPackCount(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))} />
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={dropPublic} onChange={(e) => setDropPublic(e.target.checked)} /> 公开被丢弃的卡牌</label>
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
              <label className="flex items-center gap-2">构筑秒数 <input type="number" className="w-16 rounded bg-felt-deep px-1 py-1" value={Number(editForm.deckbuildingSeconds)} onChange={(e) => setEditForm((f) => ({ ...f, deckbuildingSeconds: Number(e.target.value) }))} /></label>
              <label className="flex items-center gap-2">剩余卡处理
                <select className="rounded bg-felt-deep px-1 py-1" value={String(editForm.dropMode ?? 'drop_leftover')} onChange={(e) => setEditForm((f) => ({ ...f, dropMode: e.target.value }))}>
                  <option value="use_all">使用所有卡牌</option>
                  <option value="drop_leftover">丢弃无法整除的剩余卡牌</option>
                  <option value="drop_leftover_exact">公开丢弃且要求牌堆数目是玩家整数倍</option>
                </select>
              </label>
              <label className="flex items-center gap-2">卡堆组成
                <select className="rounded bg-felt-deep px-1 py-1" value={String(editForm.packStrategy ?? 'stratify')} onChange={(e) => setEditForm((f) => ({ ...f, packStrategy: e.target.value }))}>
                  <option value="stratify">主卡/额外卡按比例均匀每堆</option>
                  <option value="random">全随机</option>
                  <option value="main_then_extra">先全主卡再全额外</option>
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setEditing(false)} className="rounded px-4 py-1.5 text-slate-300 hover:bg-felt-edge">取消</button>
              <button onClick={() => void saveEdit()} className="rounded bg-gold px-4 py-1.5 font-semibold text-felt-deep hover:brightness-110">保存</button>
            </div>
          </div>
        </div>
      )}

      <section className="mt-6 rounded-lg border border-felt-edge bg-felt/60 p-4">
        <h2 className="mb-2 text-sm font-semibold text-gold">比赛列表</h2>
        <ul className="space-y-1 text-xs">
          {tournaments.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded bg-felt-deep/50 px-2 py-1">
              <span>
                <b>{t.name}</b> · {t.status} r{t.round} · {t.player_count} 人{t.frozen ? ' · 已暂停' : ''}
              </span>
              <span className="flex items-center gap-2">
                <button
                  onClick={() => { setTid(String(t.id)); }}
                  className="rounded bg-felt-edge px-2 py-0.5 hover:brightness-110"
                >
                  打开
                </button>
                <button
                  onClick={() => void act(t.frozen ? `/admin/t/${t.id}/unfreeze` : `/admin/t/${t.id}/pause`)}
                  className={`rounded px-2 py-0.5 ${t.frozen ? 'bg-red-900 text-red-100' : 'bg-felt-edge'} hover:brightness-110`}
                >
                  {t.frozen ? '暂停中' : '暂停'}
                </button>
                <button
                  onClick={() => {
                    if (!confirm('确定删除该比赛？将对局房间关闭并清除全部数据')) return;
                    adminFetch(`/admin/t/${t.id}`, 'DELETE')
                      .then(() => { setMsg('比赛已删除'); if (tid === String(t.id)) { setTid(''); setState(null); } void load(); })
                      .catch((e: any) => setMsg(e.message));
                  }}
                  className="rounded bg-red-900 px-2 py-0.5 text-red-100 hover:brightness-110"
                >
                  删除
                </button>
              </span>
            </li>
          ))}
          {tournaments.length === 0 && <li className="text-slate-500">暂无比赛（需要超级管理员令牌）</li>}
        </ul>
      </section>

      <section className="mt-6 rounded-lg border border-felt-edge bg-felt/60 p-4">
        <h2 className="mb-2 flex items-center justify-between text-sm font-semibold text-gold">
          <span>卡池管理</span>
          <a href="/admin/pool/new" className="rounded bg-gold px-3 py-1 text-xs font-semibold text-felt-deep hover:brightness-110">
            新建卡池
          </a>
        </h2>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <input className="w-40 rounded bg-felt-deep px-2 py-1 outline-none" placeholder="卡池名称" value={poolName} onChange={(e) => setPoolName(e.target.value)} />
          <textarea
            className="h-10 w-64 rounded bg-felt-deep px-2 py-1 outline-none"
            placeholder="卡牌编号（每行一个或用逗号分隔）"
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
        <ul className="space-y-1 text-xs">
          {pools.map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded bg-felt-deep/50 px-2 py-1">
              <span>
                <b>{p.name}</b> · {p.count} 张卡 · {p.createdAt.slice(0, 10)}
              </span>
              <span className="flex items-center gap-2">
                <a href={`/admin/pool/${p.id}`} className="rounded bg-felt-edge px-2 py-0.5 text-slate-200 hover:brightness-110">
                  编辑
                </a>
                <button
                  onClick={() => {
                    if (!confirm('确定删除卡池？')) return;
                    adminFetch(`/admin/pools/${p.id}`, 'DELETE')
                      .then(() => { setMsg('卡池已删除'); void load(); })
                      .catch((e: any) => setMsg(e.message));
                  }}
                  className="rounded bg-red-900 px-2 py-0.5 text-red-100 hover:brightness-110"
                >
                  删除
                </button>
              </span>
            </li>
          ))}
          {pools.length === 0 && <li className="text-slate-500">暂无卡池（需要超级管理员令牌）</li>}
        </ul>
      </section>
    </main>
  );
}
