'use client';

import { useEffect, useState } from 'react';
import { CardWithTooltip } from './CardImage';
import { IdentityWidget, LocalPicsSetting } from './IdentityWidget';
import { FontSizeSetting } from './FontSizeController';
import { CardInfo } from '@/lib/types';
import { flipIds } from '@/lib/useFlip';

export interface DraftState {
  id: number;
  name: string;
  status: string;
  round: number;
  frozen: boolean;
  config: Record<string, unknown>;
  players: { playerId: string; displayName: string; seat: number; ready?: boolean }[];
  pickedCards: number[];
  cardsRemainingToDraft: number;
  cardsRemainingExact: boolean;
  disqualified: boolean;
  droppedCards: number[];
  phaseDeadline: string | null;
  phaseDeadlineRemainingMs?: number;
  pendingPhase: string | null;
  poolInfo: { name: string; count: number };
  pack: {
    index: number;
    cardsLeft: number;
    packsRemaining: number;
    currentPicker: string;
    deadlineAt: string | null;
    pausedRemainingMs?: number;
    isMyTurn: boolean;
    queueLength?: number; // passing 模式：本人牌堆队列长度
    reserveMs?: number; // passing 模式：本人剩余保留时间（ms）；deadlineAt - reserveMs = 基础时间用尽时刻
    cards?: number[];
    droppedCard?: number | null;
  } | null;
  draftReserveMs?: number;
  // 本人最后点击的候选牌；超时自动选牌优先使用它。
  pickAlternative?: number | null;
  // passing 模式：所有玩家的牌堆队列长度（仅数量，dev_docs/05 §3 信息隐藏）
  queueLengths?: { playerId: string; length: number }[];
  pause: { pausedAt: string; actor?: string } | null;
  deck: { main: number[]; extra: number[]; side: number[]; lockedAt: string | null };
}

const STATUS_TEXT: Record<string, string> = {
  registration: '报名中',
  drafting: '选牌中',
  deckbuilding: '构筑中',
  matches: '对战中',
  finished: '已结束',
};

// 每秒 tick，驱动倒计时实时更新（dev_docs/06 §2）
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function TopBar({
  state,
  pid,
  token,
  tid,
  alternativeName,
  onDisplayNameChange,
  onReadyChange,
}: {
  state: DraftState;
  pid: string;
  token: string;
  tid: string;
  alternativeName?: string | null;
  onDisplayNameChange?: (displayName: string) => Promise<void>;
  onReadyChange?: (ready: boolean) => Promise<void>;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [readyBusy, setReadyBusy] = useState(false);
  const pack = state.pack;
  const cfg = state.config;
  const me = state.players.find((p) => p.playerId === pid);
  const readyCount = state.players.filter((p) => p.ready === true).length;
  const formatText = cfg.matchFormat === 'round_robin' ? '单循环' : cfg.matchFormat === 'double_elimination' ? '双败淘汰' : cfg.matchFormat === 'swiss' ? `瑞士 ${String(cfg.swissRoundCount ?? '-')} 轮${Number(cfg.playoffSize ?? 0) ? ` + Top ${String(cfg.playoffSize)} 淘汰` : ''}` : '历史自动赛制';
  const now = useNowTick(!!pack?.isMyTurn && !!pack?.deadlineAt);

  const secondsLeft = pack?.pausedRemainingMs !== undefined
    ? Math.max(0, Math.ceil(pack.pausedRemainingMs / 1000))
    : pack?.deadlineAt
      ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - now) / 1000))
      : null;
  // passing 保留时间：base 期显示基础倒计时 + 保留余额；reserve 期红色显示保留倒计时
  const reserveMs = pack?.reserveMs ?? state.draftReserveMs ?? 0;
  const baseLeft = pack?.pausedRemainingMs !== undefined
    ? Math.max(0, Math.ceil((pack.pausedRemainingMs - reserveMs) / 1000))
    : pack?.deadlineAt
      ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - reserveMs - now) / 1000))
      : null;
  const inReserve = baseLeft !== null && baseLeft <= 0 && secondsLeft !== null && secondsLeft > 0;
  const fmtReserve = (ms: number) => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  };

  const pickerName = state.players.find((p) => p.playerId === pack?.currentPicker)?.displayName ?? pack?.currentPicker;

  return (
    <header className="sticky top-0 z-40 border-b border-felt-edge bg-felt/95 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 text-sm font-bold text-gold"><i className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.8)]" />{state.name}</span>
          <span className="rounded-full border border-emerald-200/10 bg-felt-edge px-2.5 py-0.5 text-xs text-slate-200">{STATUS_TEXT[state.status] ?? state.status}</span>
          {state.frozen && <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-200">管理员冻结</span>}
          <button onClick={() => setShowInfo((v) => !v)} className="rounded bg-felt-edge px-2 py-0.5 text-xs hover:brightness-110">
            详情
          </button>
          {showInfo && (
            <span className="text-xs text-slate-400">
              {String(cfg.maxPlayers ?? '-')} 人 · {formatText} · {cfg.mode === 'match' ? '三局两胜' : '单局'} · 每堆 {String(cfg.packSize ?? `${String(cfg.packSizeMultiple ?? 3)}×人数`)} 张 · 卡池 {state.poolInfo?.name ?? cfg.cardPool ?? '-'}（{String(state.poolInfo?.count ?? '-')} 张）· 主卡组 {String(cfg.mainMin)}-{String(cfg.mainMax)} · 额外 {String(cfg.extraMax)} · 副卡组 {String(cfg.sideMax)} · 选牌限时 {String(cfg.pickSeconds)} 秒
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {state.status === 'drafting' && state.queueLengths ? (
            // passing 模式：状态栏展示每位玩家的牌堆队列长度（高亮自己）；人多时横向滚动不挤破布局
            <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto text-slate-200">
              <span className="shrink-0 text-slate-400">队列</span>
              {state.queueLengths.map((q, index) => {
                const name = state.players.find((p) => p.playerId === q.playerId)?.displayName ?? q.playerId;
                return (
                  <span key={q.playerId} className="flex shrink-0 items-center gap-2">
                    {index > 0 && <span className="text-emerald-300/50">→</span>}
                    <span className={q.playerId === pid ? 'font-semibold text-gold' : ''}>{name} <b>{q.length}</b></span>
                  </span>
                );
              })}
              <span className="shrink-0 rounded bg-felt-edge px-2 py-0.5 text-emerald-100">
                {state.cardsRemainingExact ? '还可获得' : '预计还可获得'} <b>{state.cardsRemainingToDraft}</b> 张
              </span>
              {state.pickAlternative !== null && state.pickAlternative !== undefined && (
                <span className="shrink-0 rounded bg-amber-950 px-2 py-0.5 text-amber-200" title={`候选卡编号 ${state.pickAlternative}`}>
                  备选：<b>{alternativeName ?? state.pickAlternative}</b>
                </span>
              )}
              {pack && secondsLeft !== null && (
                pack.pausedRemainingMs !== undefined ? (
                  <span className="rounded bg-amber-950 px-2 py-0.5 font-mono text-amber-200">已暂停 · 剩余 {secondsLeft} 秒</span>
                ) : inReserve ? (
                  <span className="rounded bg-red-900 px-2 py-0.5 font-mono text-red-100">保留时间 {secondsLeft} 秒</span>
                ) : (
                  <span className={`rounded px-2 py-0.5 font-mono ${baseLeft !== null && baseLeft <= 5 ? 'bg-red-900 text-red-100' : 'bg-felt-edge text-gold'}`}>
                    {baseLeft ?? secondsLeft} 秒{reserveMs > 0 && <span className="text-slate-300"> · 保留 {fmtReserve(reserveMs)}</span>}
                  </span>
                )
              )}
              {!pack && state.draftReserveMs !== undefined && (
                <span className="shrink-0 rounded bg-felt-edge px-2 py-0.5 font-mono text-slate-200">
                  保留 {fmtReserve(state.draftReserveMs)}
                </span>
              )}
            </div>
          ) : pack ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-200">
              <span>
                第 <b className="text-gold">{pack.index + 1}</b> 堆 / 共 {pack.packsRemaining + pack.index} 堆
              </span>
              <span>
                剩余 <b>{pack.cardsLeft}</b> 张
              </span>
              <span>
                正在选牌：<b className="text-gold">{pickerName}</b>
              </span>
              {state.pickAlternative !== null && state.pickAlternative !== undefined && (
                <span className="rounded bg-amber-950 px-2 py-0.5 text-amber-200" title={`候选卡编号 ${state.pickAlternative}`}>
                  备选：<b>{alternativeName ?? state.pickAlternative}</b>
                </span>
              )}
              {pack.isMyTurn && secondsLeft !== null && (
                <span className={`rounded px-2 py-0.5 font-mono ${secondsLeft <= 5 ? 'bg-red-900 text-red-100' : 'bg-felt-edge text-gold'}`}>
                  {secondsLeft} 秒
                </span>
              )}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setShowPlayers((v) => !v)}
            className="rounded bg-felt-edge px-2 py-1 text-xs hover:brightness-110"
            title="展开查看报名玩家与准备情况"
          >
            玩家 {readyCount}/{state.players.length}
          </button>
          {state.status === 'registration' && onReadyChange && (
            <button
              type="button"
              disabled={readyBusy}
              onClick={() => {
                setReadyBusy(true);
                void onReadyChange(me?.ready !== true).catch(() => undefined).finally(() => setReadyBusy(false));
              }}
              className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${me?.ready === true ? 'bg-emerald-900 text-emerald-200 hover:bg-red-900 hover:text-red-200' : 'bg-gold text-felt-deep hover:brightness-110'}`}
              title={me?.ready === true ? '点击取消准备' : '准备参加本场比赛'}
            >
              {me?.ready === true ? '已准备 ✓' : '准备'}
            </button>
          )}
          <IdentityWidget
            tid={tid}
            pid={pid}
            token={token}
            displayName={state.players.find((p) => p.playerId === pid)?.displayName ?? pid}
            canEditDisplayName={state.status === 'registration'}
            onDisplayNameChange={onDisplayNameChange}
          />
          <LocalPicsSetting />
          <FontSizeSetting />
        </div>
      </div>
      {showPlayers && (
        <div className="border-t border-felt-edge/80 bg-felt-deep/70 px-4 py-2">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-200">报名玩家</span>
            <span className={readyCount === state.players.length && state.players.length > 0 ? 'text-emerald-300' : 'text-slate-400'}>
              {readyCount}/{state.players.length} 已准备
            </span>
          </div>
          <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {state.players.map((player, index) => (
              <div key={player.playerId} className="flex min-w-0 items-center justify-between gap-2 rounded bg-felt px-2 py-1 text-xs">
                <span className="min-w-0 truncate text-slate-200" title={player.displayName || player.playerId}>
                  <span className="mr-1 text-slate-500">#{index + 1}</span>
                  {player.displayName || player.playerId}
                  {player.playerId === pid && <span className="ml-1 text-gold">（你）</span>}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 ${player.ready === true ? 'bg-emerald-950 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                  {player.ready === true ? '已准备' : '未准备'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

// Insertion index for a drop at (x, y): first grid child whose center is
// after the drop point (row-aware: compare row first, then x); default append.
function dropIndex(container: HTMLElement, x: number, y: number, count: number): number {
  const kids = container.querySelectorAll('[data-idx]');
  for (const kid of kids) {
    const r = kid.getBoundingClientRect();
    if (y < r.top) return Number(kid.getAttribute('data-idx')); // drop is on an earlier row
    if (y < r.bottom && x < r.left + r.width / 2) return Number(kid.getAttribute('data-idx')); // same row, left of center
  }
  return count;
}

export function DeckZone({ title, zone, codes, limit, cardMap, onCardDrop, onCardPick, onCardMove }: {
  title: string;
  zone: 'main' | 'extra' | 'side';
  codes: number[];
  limit?: string;
  cardMap?: Record<number, CardInfo>;
  onCardDrop?: (code: number) => void;
  onCardPick?: (code: number, zone: 'main' | 'extra' | 'side') => void;
  onCardMove?: (code: number, from: string, to: string, index?: number, fromIndex?: number) => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const draggable = !!onCardMove || !!onCardDrop;
  const acceptsDrop = !!onCardPick || !!onCardMove || !!onCardDrop;
  // Always render the server order. New cards therefore remain at the end and
  // manual drag indices map directly to persisted indices.
  const ids = flipIds(zone, codes);
  return (
    <section
      onDragOver={(e) => {
        if (!acceptsDrop) return;
        e.preventDefault();
        if (onCardMove) setHoverIdx(dropIndex(e.currentTarget, e.clientX, e.clientY, codes.length));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoverIdx(null);
      }}
      onDrop={acceptsDrop ? (e) => {
        e.preventDefault();
        setHoverIdx(null);
        const code = Number(e.dataTransfer.getData('text/plain'));
        if (!code) return;
        const zoneKind = e.dataTransfer.getData('application/x-card-zone');
        if (zoneKind === 'pack') {
          onCardPick?.(code, zone);
        } else if (zoneKind === 'deck') {
          const from = e.dataTransfer.getData('application/x-card-source') || 'pool';
          const rawFromIndex = e.dataTransfer.getData('application/x-card-source-index');
          const fromIndex = rawFromIndex === '' ? undefined : Number(rawFromIndex);
          const index = dropIndex(e.currentTarget, e.clientX, e.clientY, codes.length);
          // Indices refer to the pre-move arrays. The backend performs same-zone
          // removal adjustment atomically, including duplicate cards.
          onCardMove?.(code, from, zone, index, fromIndex);
        } else {
          onCardDrop?.(code);
        }
      } : undefined}
      className="rounded-lg border border-felt-edge bg-felt/60 p-2"
    >
      <header className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-300">
        <span className="font-semibold">{title}</span>
        <span className="font-mono text-gold">
          {codes.length}
          {limit ? ` / ${limit}` : ''}
        </span>
      </header>
      <div className="card-grid">
        {codes.map((c, i) => (
          <div
            key={ids[i]}
            data-idx={i}
            data-flip-id={ids[i]}
            draggable={draggable}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', String(c));
              e.dataTransfer.setData('application/x-card-zone', 'deck');
              e.dataTransfer.setData('application/x-card-source', zone);
              e.dataTransfer.setData('application/x-card-source-index', String(i));
            }}
            className="animate-card-in relative cursor-grab active:cursor-grabbing"
          >
            {hoverIdx === i && <span className="absolute inset-y-0 -left-0.5 z-10 w-0.5 rounded bg-gold" />}
            {hoverIdx === codes.length && i === codes.length - 1 && (
              <span className="absolute inset-y-0 -right-0.5 z-10 w-0.5 rounded bg-gold" />
            )}
            <CardWithTooltip code={c} card={cardMap?.[c]} />
          </div>
        ))}
      </div>
      {acceptsDrop && (
        <div className="mt-1 rounded border border-dashed border-felt-edge py-0.5 text-center text-[0.625rem] text-slate-500">
          拖放到本区域
        </div>
      )}
    </section>
  );
}
