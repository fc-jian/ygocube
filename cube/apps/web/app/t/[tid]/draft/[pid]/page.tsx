'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, apiDownload, clearStoredToken, encodePathSegment, Identity, readableApiError, resolvePlayerIdentity } from '@/lib/api';
import { useTournamentStream } from '@/lib/sse';
import { TopBar, DeckZone, DraftState, useNowTick } from '@/components/TopBar';
import { PackZone } from '@/components/PackZone';
import { TokenPrompt } from '@/components/TokenPrompt';
import { CardSearchAll } from '@/components/CardSearchAll';
import { closeCardPreview, setCardPreviewAction } from '@/components/CardPreview';
import { PoolPreview } from '@/components/PoolPreview';
import { CardInfo } from '@/lib/types';
import { matchesCardQuery, PickSortMode, safeCardCodes, sortCardSearchResults } from '@/lib/cardInfo';
import { fetchCardMetadata } from '@/lib/cardCache';
import { useTournamentFallbackPolling } from '@/lib/sse';

export default function DraftPage() {
  const params = useParams<{ tid: string; pid: string }>();
  const router = useRouter();
  const tid = params.tid;
  const pid = params.pid;
  const tidPath = encodePathSegment(tid);
  const pidPath = encodePathSegment(pid);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [notJoined, setNotJoined] = useState(false);
  const [state, setState] = useState<DraftState | null>(null);
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [error, setError] = useState('');
  const [cardFilter, setCardFilter] = useState('');
  const [poolCodes, setPoolCodes] = useState<number[]>([]);
  const [poolSearch, setPoolSearch] = useState('');
  const [poolResults, setPoolResults] = useState<CardInfo[]>([]);
  const [cardSortMode, setCardSortMode] = useState<PickSortMode>('default');
  const [draftConfirmBusy, setDraftConfirmBusy] = useState(false);
  const loadBusy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api<{ authRequired: boolean; players: { playerId: string }[] }>(`/t/${tidPath}`, { identity: null });
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
  }, [tidPath, pid]);

  const load = useCallback(async () => {
    if (!identity || loadBusy.current) return;
    loadBusy.current = true;
    try {
      const raw = await api<unknown>(`/t/${tidPath}/state`, { identity });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_STATE_RESPONSE');
      const s = raw as DraftState;
      const normalized = {
        ...s,
        pickedCards: safeCardCodes(s.pickedCards),
        droppedCards: safeCardCodes(s.droppedCards),
        pack: s.pack && typeof s.pack === 'object' ? { ...s.pack, cards: safeCardCodes(s.pack.cards) } : null,
        deck: s.deck && typeof s.deck === 'object' ? {
          ...s.deck,
          main: safeCardCodes(s.deck.main),
          extra: safeCardCodes(s.deck.extra),
          side: safeCardCodes(s.deck.side),
        } : { main: [], extra: [], side: [], lockedAt: null },
      } as DraftState;
      setState(normalized);
      const alternativeCode = typeof normalized.pickAlternative === 'number' && Number.isSafeInteger(normalized.pickAlternative) && normalized.pickAlternative > 0
        ? normalized.pickAlternative
        : null;
      const codes = new Set<number>([
        ...normalized.pickedCards,
        ...safeCardCodes(normalized.pack?.cards),
        ...normalized.droppedCards,
        ...normalized.deck.main,
        ...normalized.deck.extra,
        ...normalized.deck.side,
        ...(alternativeCode !== null ? [alternativeCode] : []),
      ]);
      if (codes.size) {
        const cards = await fetchCardMetadata(`/t/${tidPath}/cards`, [...codes], identity);
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
        setError(readableApiError(e, '比赛状态加载失败'));
      }
    } finally {
      loadBusy.current = false;
    }
  }, [tidPath, identity]);

  const updateDisplayName = useCallback(async (displayName: string) => {
    if (!identity) return;
    const result = await api<{ playerId: string; displayName: string }>(`/t/${tidPath}/player/name`, {
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
  }, [identity, pid, tidPath]);

  const updateReady = useCallback(async (ready: boolean) => {
    if (!identity) return;
    try {
      const result = await api<{ playerId: string; ready: boolean }>(`/t/${tidPath}/player/ready`, {
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
      setError(e?.code === 'WRONG_PHASE' ? '报名已结束，无法修改准备状态' : readableApiError(e, '更新准备状态失败'));
      throw e;
    }
  }, [identity, pid, tidPath]);

  const confirmDraftStart = useCallback(async () => {
    if (!identity || draftConfirmBusy) return;
    setDraftConfirmBusy(true);
    try {
      await api(`/t/${tidPath}/player/draft-confirm`, { method: 'POST', identity });
      await load();
    } catch (e: any) {
      setError(readableApiError(e, '确认开始选牌失败'));
      throw e;
    } finally {
      setDraftConfirmBusy(false);
    }
  }, [draftConfirmBusy, identity, load, tidPath]);

  const leaveRegistration = useCallback(async () => {
    if (!identity) return;
    await api(`/t/${tidPath}/player/withdraw`, { method: 'POST', identity });
    clearStoredToken(tid, pid);
    router.replace(`/t/${tidPath}`);
  }, [identity, pid, router, tidPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // After a player has pressed the preparation/confirmation button, keep a
  // short polling loop even when SSE is connected.  The one-minute handshake
  // is intentionally bounded to five-second requests so every page notices a
  // timeout or the final approval promptly.
  const startConfirmationPending = state?.status === 'registration' && state.draftStartConfirmation?.pending === true;
  const registrationReady = state?.status === 'registration' && state.players.find((player) => player.playerId === pid)?.ready === true;
  useEffect(() => {
    if (!identity || (!startConfirmationPending && !registrationReady)) return;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        await load();
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 5_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [identity, load, registrationReady, startConfirmationPending]);

  // 未开始选牌时：加载 drop 前卡池 + 全部卡牌元数据，供浏览/搜索（标记是否在池中）
  useEffect(() => {
    if (state?.status !== 'registration' || !identity) return;
    let cancelled = false;
    let refreshing = false;
    const refreshPool = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const r = await api<unknown>(`/t/${tidPath}/pool`, { identity });
        const rawCodes = r && typeof r === 'object' && Array.isArray((r as { codes?: unknown }).codes)
          ? (r as { codes: unknown[] }).codes
          : [];
        const codes = rawCodes.filter((code): code is number => typeof code === 'number' && Number.isSafeInteger(code) && code > 0);
        for (let i = 0; i < codes.length; i += 500) {
          const chunk = codes.slice(i, i + 500);
          const meta = await fetchCardMetadata(`/t/${tidPath}/cards`, chunk, identity);
          const map: Record<number, CardInfo> = {};
          for (const c of meta) map[c.code] = c;
          if (!cancelled) setCardMap((m) => ({ ...m, ...map }));
        }
        if (!cancelled) {
          setPoolCodes(codes);
        }
      } catch {
        if (!cancelled) setPoolCodes([]);
      } finally {
        refreshing = false;
      }
    };
    void refreshPool();
    const timer = window.setInterval(() => void refreshPool(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state?.status, identity, tidPath]);

  const searchPool = async () => {
    if (!poolSearch.trim() || !identity) {
      setPoolResults([]);
      return;
    }
    try {
      const payload = await api<unknown>(`/t/${tidPath}/cards?q=${encodeURIComponent(poolSearch.trim())}`, { identity });
      if (!Array.isArray(payload)) throw new Error('INVALID_CARD_RESPONSE');
      setPoolResults(sortCardSearchResults(payload as CardInfo[], poolSearch));
    } catch {
      setPoolResults([]);
    }
  };

  const { connected } = useTournamentStream(tid, identity, useCallback((event: string) => {
    if (event === 'pack' || event === 'pick' || event === 'pause' || event === 'phase' || event === 'deck' || event === 'notice') void load();
  }, [load]));

  // 倒计时归零时立即刷新（超时自动选牌可能已发生）。
  const now = useNowTick(true);
  const confirmationNow = useNowTick(startConfirmationPending);
  const secondsLeft = state?.pack?.deadlineAt ? Math.max(0, Math.ceil((new Date(state.pack.deadlineAt).getTime() - now) / 1000)) : null;
  const wasMyTurn = useRef(false);
  useEffect(() => {
    if (state?.pack?.isMyTurn) wasMyTurn.current = true;
    if (secondsLeft === 0 && wasMyTurn.current) {
      wasMyTurn.current = false;
      void load();
    }
  }, [secondsLeft, state?.pack?.isMyTurn, load]);
  useTournamentFallbackPolling({
    connected,
    enabled: !!identity && (state?.status === 'drafting' || state?.status === 'registration' || state?.status === 'deckbuilding'),
    intervalMs: state?.status === 'drafting' || state?.status === 'deckbuilding' ? 10_000 : 15_000,
    onPoll: load,
  });

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
      await api(`/t/${tidPath}/pick`, { method: 'POST', body: { card_code: code, ...(targetZone ? { target_zone: targetZone } : {}) }, identity });
      await load();
    } catch (e: any) {
      setError(e.code === 'NOT_YOUR_TURN' ? '当前没有可选择的牌堆（等待传递）' : (e.code === 'CARD_NOT_AVAILABLE' ? '该卡已被选走' : readableApiError(e, '选牌失败')));
    }
  };

  const setAlternative = async (code: number) => {
    const previous = state?.pickAlternative ?? null;
    setState((current) => current ? { ...current, pickAlternative: code } : current);
    try {
      await api(`/t/${tidPath}/pick/alternative`, { method: 'POST', body: { card_code: code }, identity });
    } catch (e: any) {
      // The card may have been passed/selected between the click and request;
      // keep the normal pick flow usable while surfacing other failures.
      setState((current) => current ? { ...current, pickAlternative: previous } : current);
      if (e.code !== 'CARD_NOT_AVAILABLE' && e.code !== 'NOT_YOUR_TURN') setError(readableApiError(e, '添加卡片失败'));
    }
  };

  const move = async (code: number, from: string, to: string, index?: number, fromIndex?: number) => {
    // Actions invoked from the fixed card-detail window must close it
    // immediately, including failed requests, so it cannot obscure the updated
    // deck or invite duplicate clicks.
    closeCardPreview();
    try {
      await api(`/t/${tidPath}/deck/move`, { method: 'POST', body: { card_code: code, from, to, ...(index !== undefined ? { index } : {}), ...(fromIndex !== undefined ? { from_index: fromIndex } : {}) }, identity });
      await load();
    } catch (e: any) {
      setError(e.code === 'WRONG_ZONE' ? '该类型卡不能放入此区域' : readableApiError(e));
    }
  };

  const sortDeck = async () => {
    try {
      await api(`/t/${tidPath}/deck/sort`, { method: 'POST', identity });
      await load();
    } catch (e: any) {
      setError(readableApiError(e, '整理卡组失败'));
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
  }, [state, identity, tidPath, move]);

  if (needToken) return <TokenPrompt tid={tid} pid={pid} onToken={(t) => { setNeedToken(false); setIdentity({ tid, pid, token: t }); }} />;
  if (notJoined)
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-lg text-slate-200">你还没有报名参加这个比赛</p>
        <a href={`/t/${tidPath}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
          前往报名
        </a>
      </main>
    );
  if (error && !state) return <main className="p-8 text-red-300">{error}</main>;
  if (!state || !identity) return <main className="p-8 text-slate-400">加载中…</main>;

  const deck = state.deck ?? { main: [], extra: [], side: [], lockedAt: null };
  const configuredPoolId = Number(state.config.cardPoolId);
  const poolId = Number.isSafeInteger(configuredPoolId) ? configuredPoolId : undefined;
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
        onDraftStartConfirm={state.status === 'registration' ? confirmDraftStart : undefined}
        onLeaveRegistration={state.status === 'registration' ? leaveRegistration : undefined}
      />
      {state.status === 'registration' && state.draftStartConfirmation?.pending && !state.draftStartConfirmation.confirmed && (
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/65 px-4" role="dialog" aria-modal="true" aria-labelledby="draft-start-confirm-title">
          <div className="w-full max-w-md rounded-xl border border-gold/50 bg-felt-deep p-5 shadow-2xl">
            <h2 id="draft-start-confirm-title" className="text-lg font-bold text-gold">管理员请求开始选牌</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-200">
              请确认你已准备好参加本场选牌。所有玩家都在一分钟内确认后才会开始，否则本次请求自动取消。
            </p>
            <p className="mt-2 text-xs text-slate-400">
              已确认 {state.draftStartConfirmation.confirmedCount}/{state.draftStartConfirmation.total} 人 · 截止 {Math.max(0, Math.ceil((new Date(state.draftStartConfirmation.deadlineAt).getTime() - confirmationNow) / 1000))} 秒
            </p>
            <button
              type="button"
              disabled={draftConfirmBusy || confirmationNow >= new Date(state.draftStartConfirmation.deadlineAt).getTime()}
              onClick={() => void confirmDraftStart().catch(() => undefined)}
              className="mt-4 w-full rounded bg-gold px-4 py-2 font-semibold text-felt-deep hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {draftConfirmBusy ? '提交中…' : '确认开始选牌'}
            </button>
          </div>
        </div>
      )}
      {state.status === 'registration' && state.draftStartConfirmation?.pending && state.draftStartConfirmation.confirmed && (
        <div className="mx-3 mt-3 rounded border border-emerald-300/30 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200" role="status">
          已确认开始选牌，等待其他玩家确认（{state.draftStartConfirmation.confirmedCount}/{state.draftStartConfirmation.total}）。
        </div>
      )}
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
              sortMode={cardSortMode}
              onSortModeChange={setCardSortMode}
              poolId={poolId}
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
          sortMode={cardSortMode}
          onSortModeChange={setCardSortMode}
          poolId={poolId}
        />
      )}
      {state.status === 'deckbuilding' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-lg text-slate-200">选牌完成，开始构筑卡组吧！</p>
          <a href={`/t/${tidPath}/deck/${pidPath}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
            前往构筑卡组
          </a>
        </div>
      )}
      {state.status === 'matches' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-lg text-slate-200">对战已开始。</p>
          <a href={`/t/${tidPath}/matches/${pidPath}`} className="rounded bg-gold px-6 py-2 font-semibold text-felt-deep hover:brightness-110">
            前往对战页面
          </a>
        </div>
      )}
      <footer className="flex items-center justify-between border-t border-felt-edge bg-felt px-4 py-2">
        <span className="text-xs text-slate-400">已选 {state.pickedCards?.length ?? 0} 张</span>
        <button
          onClick={() => void apiDownload(`/t/${tidPath}/deck.ydk`, identity).catch(() => setError('下载失败'))}
          className="rounded bg-felt-edge px-4 py-1.5 text-sm hover:brightness-110"
        >
          下载 ydk
        </button>
      </footer>
      {state.pause && (
        <div className="mx-3 mb-2 rounded border border-red-400/30 bg-red-950/40 px-3 py-2 text-xs text-red-200" role="status">
          比赛已由管理员暂停；倒计时已冻结，等待后台恢复。
        </div>
      )}
      {error && <div className="mx-3 mb-2 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200">{error}</div>}
    </main>
  );
}
