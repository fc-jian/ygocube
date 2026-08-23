'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, apiDownload, Identity, resolvePlayerIdentity } from '@/lib/api';
import { useTournamentStream } from '@/lib/sse';
import { TopBar, DeckZone, DraftState, useNowTick } from '@/components/TopBar';
import { PackZone } from '@/components/PackZone';
import { TokenPrompt } from '@/components/TokenPrompt';
import { CardSearchAll } from '@/components/CardSearchAll';
import { setCardPreviewAction } from '@/components/CardPreview';
import { PoolPreview } from '@/components/PoolPreview';
import { CardInfo } from '@/lib/types';
import { matchesCardQuery, sortCardSearchResults } from '@/lib/cardInfo';

export default function DraftPage() {
  const params = useParams<{ tid: string; pid: string }>();
  const tid = params.tid;
  const pid = params.pid;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [notJoined, setNotJoined] = useState(false);
  const [state, setState] = useState<DraftState | null>(null);
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [error, setError] = useState('');
  const [pauseAction, setPauseAction] = useState('propose');
  const [cardFilter, setCardFilter] = useState('');
  const [poolCodes, setPoolCodes] = useState<number[]>([]);
  const [poolSearch, setPoolSearch] = useState('');
  const [poolResults, setPoolResults] = useState<CardInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api<{ authRequired: boolean; players: { playerId: string }[] }>(`/t/${tid}`, { identity: null });
        if (!cancelled) {
          if (!info.players?.some((p) => p.playerId === pid)) {
            setNotJoined(true);
            return;
          }
          if (info.authRequired === false) {
            setIdentity({ tid, pid, token: '' });
          } else {
            const r = resolvePlayerIdentity(tid, pid);
            if ('needToken' in r) setNeedToken(true);
            else setIdentity(r.identity);
          }
        }
      } catch {
        if (!cancelled) setError('比赛不存在');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tid, pid]);

  const load = useCallback(async () => {
    if (!identity) return;
    try {
      const s = await api<DraftState>(`/t/${tid}/state`, { identity });
      setState(s);
      const codes = new Set<number>([...(s.pickedCards ?? []), ...(s.pack?.cards ?? []), ...(s.droppedCards ?? []), ...(s.deck?.main ?? []), ...(s.deck?.extra ?? []), ...(s.deck?.side ?? []), ...(s.pickAlternative !== null && s.pickAlternative !== undefined ? [s.pickAlternative] : [])]);
      if (codes.size) {
        const cards = await api<CardInfo[]>(`/t/${tid}/cards?codes=${[...codes].join(',')}`, { identity });
        const map: Record<number, CardInfo> = {};
        for (const c of cards) map[c.code] = c;
        setCardMap((m) => ({ ...m, ...map }));
      }
    } catch (e: any) {
      if (e.code === 'AUTH_REQUIRED') {
        setIdentity(null);
        setNeedToken(true);
      } else if (e.code === 'PLAYER_NOT_FOUND' || e.code === 'NOT_FOUND') {
        setNotJoined(true);
      } else {
        setError(e.code ?? String(e));
      }
    }
  }, [tid, identity]);

  const updateDisplayName = useCallback(async (displayName: string) => {
    if (!identity) return;
    const result = await api<{ playerId: string; displayName: string }>(`/t/${tid}/player/name`, {
      method: 'POST',
      body: { display_name: displayName },
      identity,
    });
    setState((current) => current
      ? {
          ...current,
          players: current.players.map((player) => player.playerId === pid
            ? { ...player, displayName: result.displayName }
            : player),
        }
      : current);
  }, [identity, pid, tid]);

  const updateReady = useCallback(async (ready: boolean) => {
    if (!identity) return;
    try {
      const result = await api<{ playerId: string; ready: boolean }>(`/t/${tid}/player/ready`, {
        method: 'POST',
        body: { ready },
        identity,
      });
      setState((current) => current
        ? {
            ...current,
            players: current.players.map((player) => player.playerId === pid
              ? { ...player, ready: result.ready }
              : player),
          }
        : current);
    } catch (e: any) {
      setError(e?.code === 'WRONG_PHASE' ? '报名已结束，无法修改准备状态' : (e?.code ?? String(e)));
      throw e;
    }
  }, [identity, pid, tid]);

  useEffect(() => {
    void load();
  }, [load]);

  // 未开始选牌时：加载 drop 前卡池 + 全部卡牌元数据，供浏览/搜索（标记是否在池中）
  useEffect(() => {
    if (state?.status !== 'registration' || !identity) return;
    let cancelled = false;
    const refreshPool = async () => {
      try {
        const r = await api<{ codes: number[] }>(`/t/${tid}/pool`, { identity });
        const map: Record<number, CardInfo> = {};
        for (let i = 0; i < r.codes.length; i += 500) {
          const chunk = r.codes.slice(i, i + 500);
          const meta = await api<CardInfo[]>(`/t/${tid}/cards?codes=${chunk.join(',')}`, { identity });
          for (const c of meta) map[c.code] = c;
        }
        if (!cancelled) {
          setPoolCodes(r.codes);
          setCardMap((m) => ({ ...m, ...map }));
        }
      } catch {
        if (!cancelled) setPoolCodes([]);
      }
    };
    void refreshPool();
    const timer = window.setInterval(() => void refreshPool(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state?.status, identity, tid]);

  const searchPool = async () => {
    if (!poolSearch.trim() || !identity) {
      setPoolResults([]);
      return;
    }
    try {
      const cards = await api<CardInfo[]>(`/t/${tid}/cards?q=${encodeURIComponent(poolSearch.trim())}`, { identity });
      setPoolResults(sortCardSearchResults(cards, poolSearch));
    } catch {
      setPoolResults([]);
    }
  };

  useTournamentStream(tid, identity, useCallback((event: string) => {
    if (event === 'pack' || event === 'pick' || event === 'pause' || event === 'phase' || event === 'deck' || event === 'notice') void load();
  }, [load]));

  // 倒计时归零时立即刷新（超时自动选牌可能已发生），选牌期间每 5 秒兜底轮询
  const now = useNowTick(true);
  const secondsLeft = state?.pack?.deadlineAt ? Math.max(0, Math.ceil((new Date(state.pack.deadlineAt).getTime() - now) / 1000)) : null;
  const wasMyTurn = useRef(false);
  useEffect(() => {
    if (state?.pack?.isMyTurn) wasMyTurn.current = true;
    if (secondsLeft === 0 && wasMyTurn.current) {
      wasMyTurn.current = false;
      void load();
    }
  }, [secondsLeft, state?.pack?.isMyTurn, load]);
  useEffect(() => {
    if (state?.status !== 'drafting' && state?.status !== 'registration' && state?.status !== 'deckbuilding') return;
    // 选牌阶段高频轮询，其他玩家选完后及时获得新列表（dev_docs/06 §6）
    const intervalMs = state?.status === 'drafting' ? 2000 : state?.status === 'deckbuilding' ? 3000 : 5000;
    const t = setInterval(() => void load(), intervalMs);
    return () => clearInterval(t);
  }, [state?.status, load]);

  const pick = async (code: number, targetZone?: 'main' | 'extra' | 'side') => {
    // 拖拽到指定区域时校验类型（与 ygopro 一致：主卡组不收额外卡，额外区只收额外卡）
    if (targetZone && cardMap[code]) {
      const extra = !!(cardMap[code].type & 0x4802040);
      if (targetZone === 'main' && extra) {
        setError('额外卡不能拖入主卡组');
        return;
      }
      if (targetZone === 'extra' && !extra) {
        setError('主卡组/副卡组卡不能拖入额外区');
        return;
      }
    }
    try {
      await api(`/t/${tid}/pick`, { method: 'POST', body: { card_code: code, ...(targetZone ? { target_zone: targetZone } : {}) }, identity });
      await load();
    } catch (e: any) {
      setError(e.code === 'NOT_YOUR_TURN' ? '当前没有可选择的牌堆（等待传递）' : (e.code === 'CARD_NOT_AVAILABLE' ? '该卡已被选走' : (e.code ?? String(e))));
    }
  };

  const setAlternative = async (code: number) => {
    const previous = state?.pickAlternative ?? null;
    setState((current) => current ? { ...current, pickAlternative: code } : current);
    try {
      await api(`/t/${tid}/pick/alternative`, { method: 'POST', body: { card_code: code }, identity });
    } catch (e: any) {
      // The card may have been passed/selected between the click and request;
      // keep the normal pick flow usable while surfacing other failures.
      setState((current) => current ? { ...current, pickAlternative: previous } : current);
      if (e.code !== 'CARD_NOT_AVAILABLE' && e.code !== 'NOT_YOUR_TURN') setError(e.code ?? String(e));
    }
  };

  const move = async (code: number, from: string, to: string, index?: number, fromIndex?: number) => {
    try {
      await api(`/t/${tid}/deck/move`, { method: 'POST', body: { card_code: code, from, to, ...(index !== undefined ? { index } : {}), ...(fromIndex !== undefined ? { from_index: fromIndex } : {}) }, identity });
      await load();
    } catch (e: any) {
      setError(e.code === 'WRONG_ZONE' ? '该类型卡不能放入此区域' : (e.code ?? String(e)));
    }
  };

  const sortDeck = async () => {
    try {
      await api(`/t/${tid}/deck/sort`, { method: 'POST', identity });
      await load();
    } catch (e: any) {
      setError(e.code ?? String(e));
    }
  };

  useEffect(() => {
    if (!state || !identity) return;
    setCardPreviewAction((card) => {
      const inSide = state.deck?.side?.includes(card.code);
      const inMain = state.deck?.main?.includes(card.code);
      const inExtra = state.deck?.extra?.includes(card.code);
      if (inSide) {
        // Extra-deck cards placed in side must be returned to extra, not main.
        // The previous action always targeted main, so clicking a side Fusion/
        // Synchro/XYZ/Link card never offered the valid extra-destination action.
        const destination = (card.type & 0x4802040) !== 0 ? 'extra' : 'main';
        return {
          label: destination === 'extra' ? '移动到额外卡组' : '移动到主卡组',
          run: () => void move(card.code, 'side', destination),
        };
      }
      if (inMain || inExtra) return { label: '移动到副卡组', run: () => void move(card.code, inExtra ? 'extra' : 'main', 'side') };
      return null;
    });
    return () => setCardPreviewAction(null);
  }, [state, identity, tid, move]);

  if (needToken) return <TokenPrompt tid={tid} pid={pid} onToken={(t) => { setNeedToken(false); setIdentity({ tid, pid, token: t }); }} />;
  if (notJoined)
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-lg text-slate-200">你还没有报名参加这个比赛</p>
        <a href={`/t/${tid}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
          前往报名
        </a>
      </main>
    );
  if (error && !state) return <main className="p-8 text-red-300">{error}</main>;
  if (!state || !identity) return <main className="p-8 text-slate-400">加载中...</main>;

  // 固定预览的快捷操作：主/额外 -> 副卡组，副卡组 -> 主卡组
  const pause = async () => {
    try {
      await api(`/t/${tid}/pause`, { method: 'POST', body: { action: pauseAction }, identity });
      await load();
    } catch (e: any) {
      setError(e.code ?? String(e));
    }
  };

  const deck = state.deck ?? { main: [], extra: [], side: [], lockedAt: null };
  const q = cardFilter.trim().toLowerCase();
  const filterCodes = (codes: number[]) =>
    !q ? codes : codes.filter((c) => matchesCardQuery(cardMap[c], q));
  const actualIndex = (codes: number[], visibleIndex: number | undefined): number | undefined => {
    if (visibleIndex === undefined || !q) return visibleIndex;
    let visible = 0;
    for (let i = 0; i < codes.length; i++) {
      if (filterCodes([codes[i]]).length === 0) continue;
      if (visible++ === visibleIndex) return i;
    }
    return codes.length;
  };
  const moveVisible = (code: number, from: string, to: string, index?: number, fromIndex?: number) => {
    const zones: Record<string, number[]> = { main: deck.main, extra: deck.extra, side: deck.side };
    const actualFrom = from === 'pool' ? undefined : actualIndex(zones[from] ?? [], fromIndex);
    const actualTo = to === 'pool' ? undefined : actualIndex(zones[to] ?? [], index);
    void move(code, from, to, actualTo, actualFrom);
  };

  return (
    <main className="flex min-h-screen flex-col md:h-screen">
      <TopBar
        state={state}
        pid={pid}
        token={identity.token || '(已关闭鉴权)'}
        tid={tid}
        alternativeName={state.pickAlternative !== null && state.pickAlternative !== undefined ? cardMap[state.pickAlternative]?.name : null}
        onDisplayNameChange={updateDisplayName}
        onReadyChange={state.status === 'registration' ? updateReady : undefined}
      />
      {state.status === 'drafting' && (
        <div className="flex flex-1 flex-col gap-3 p-3 md:flex-row md:overflow-hidden">
          <div className="flex w-full flex-col gap-2 md:w-3/5 md:overflow-y-auto md:pr-1">
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded bg-felt-deep px-3 py-1.5 text-xs outline-none ring-gold/50 focus:ring-2"
                placeholder="搜索名称、编号、效果、字段或系列（空格分隔多个关键词）"
                value={cardFilter}
                onChange={(e) => setCardFilter(e.target.value)}
              />
              <button onClick={() => void sortDeck()} className="rounded bg-felt-edge px-3 py-1.5 text-xs hover:brightness-110" title="按 YGOPro 卡组编辑器逻辑整理三个卡组区域">
                整理卡组
              </button>
            </div>
            <DeckZone title="主卡组" zone="main" codes={filterCodes(deck.main)} limit={`${state.config.mainMin}-${state.config.mainMax}`} cardMap={cardMap} onCardPick={pick} onCardMove={moveVisible} />
            <DeckZone title="额外卡组" zone="extra" codes={filterCodes(deck.extra)} limit={String(state.config.extraMax)} cardMap={cardMap} onCardPick={pick} onCardMove={moveVisible} />
            <DeckZone title="副卡组" zone="side" codes={filterCodes(deck.side)} limit={String(state.config.sideMax)} cardMap={cardMap} onCardPick={pick} onCardMove={moveVisible} />
            <CardSearchAll tid={tid} identity={identity} />
          </div>
          <div className="order-first min-h-0 md:order-none md:flex-1">
            <PackZone
              pack={state.pack}
              cardMap={cardMap}
              droppedCards={state.droppedCards}
              alternativeCode={state.pickAlternative}
              onAlternative={(code) => void setAlternative(code)}
              onPick={pick}
            />
          </div>
        </div>
      )}
      {state.status === 'registration' && (
        <PoolPreview
          poolCodes={poolCodes}
          cardMap={cardMap}
          searchQuery={poolSearch}
          searchResults={poolResults}
          onSearchQuery={setPoolSearch}
          onSearch={() => void searchPool()}
          heading={`卡池预览（drop 前，共 ${poolCodes.length} 张）—— 选牌尚未开始；请点击顶部“准备”按钮确认参加，点击“玩家”可查看报名与准备情况`}
        />
      )}
      {state.status === 'deckbuilding' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-lg text-slate-200">选牌完成，开始构筑卡组吧！</p>
          <a href={`/t/${tid}/deck/${pid}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
            前往构筑卡组
          </a>
        </div>
      )}
      {state.status === 'matches' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-lg text-slate-200">对战已开始。</p>
          <a href={`/t/${tid}/matches/${pid}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
            前往对战页面
          </a>
        </div>
      )}
      <footer className="flex items-center justify-between border-t border-felt-edge bg-felt px-4 py-2">
        <span className="text-xs text-slate-400">已选 {state.pickedCards?.length ?? 0} 张</span>
        <button
          onClick={() => void apiDownload(`/t/${tid}/deck.ydk`, identity).catch(() => setError('下载失败'))}
          className="rounded bg-felt-edge px-4 py-1.5 text-sm hover:brightness-110"
        >
          下载 ydk
        </button>
      </footer>
      {state.pause && (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-3 rounded border border-felt-edge bg-felt px-3 py-2 text-xs">
          {state.pause.pausedAt ? (
            <span className="text-red-300">已暂停（发起人：{state.pause.proposer}）</span>
          ) : (
            <span className="text-slate-300">暂停投票进行中（发起人：{state.pause.proposer}）</span>
          )}
          <select className="rounded bg-felt-deep px-2 py-1" value={pauseAction} onChange={(e) => setPauseAction(e.target.value)}>
            <option value="propose">发起暂停</option>
            <option value="vote_yes">同意</option>
            <option value="vote_no">反对</option>
            <option value="resume">恢复</option>
          </select>
          <button onClick={pause} className="rounded bg-felt-edge px-3 py-1 hover:brightness-110">
            提交
          </button>
        </div>
      )}
      {error && <div className="mx-3 mb-2 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200">{error}</div>}
    </main>
  );
}
