'use client';

import { useEffect, useState } from 'react';
import { CardWithTooltip } from './CardImage';
import { IdentityWidget, LocalPicsSetting } from './IdentityWidget';
import { FontSizeSetting } from './FontSizeController';
import { CardInfo } from '@/lib/types';

export interface DraftState {
  id: number;
  name: string;
  status: string;
  round: number;
  frozen: boolean;
  config: Record<string, unknown>;
  players: { playerId: string; displayName: string; seat: number }[];
  pickedCards: number[];
  droppedCards: number[];
  phaseDeadline: string | null;
  pendingPhase: string | null;
  poolInfo: { name: string; count: number };
  pack: {
    index: number;
    cardsLeft: number;
    packsRemaining: number;
    currentPicker: string;
    deadlineAt: string;
    isMyTurn: boolean;
    cards?: number[];
    droppedCard?: number | null;
  } | null;
  pause: { pausedAt: string | null; proposer: string | null; remainingMs: number } | null;
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

export function TopBar({ state, pid, token, tid }: { state: DraftState; pid: string; token: string; tid: string }) {
  const [showInfo, setShowInfo] = useState(false);
  const pack = state.pack;
  const cfg = state.config;
  const now = useNowTick(!!pack?.isMyTurn);

  const secondsLeft = pack?.deadlineAt ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - now) / 1000)) : null;

  const pickerName = state.players.find((p) => p.playerId === pack?.currentPicker)?.displayName ?? pack?.currentPicker;

  return (
    <header className="sticky top-0 z-40 border-b border-felt-edge bg-felt/95 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-gold">{state.name}</span>
          <span className="rounded bg-felt-edge px-2 py-0.5 text-xs text-slate-200">{STATUS_TEXT[state.status] ?? state.status}</span>
          {state.frozen && <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-200">管理员冻结</span>}
          <button onClick={() => setShowInfo((v) => !v)} className="rounded bg-felt-edge px-2 py-0.5 text-xs hover:brightness-110">
            详情
          </button>
          {showInfo && (
            <span className="text-xs text-slate-400">
              {String(cfg.maxPlayers ?? '-')} 人 · {cfg.mode === 'match' ? '三局两胜' : '单局'} · 每堆 {String(cfg.packSizeMultiple ?? 3)}× 人数 · 卡池 {state.poolInfo?.name ?? cfg.cardPool ?? '-'}（{String(state.poolInfo?.count ?? '-')} 张）· 主卡组 {String(cfg.mainMin)}-{String(cfg.mainMax)} · 额外 {String(cfg.extraMax)} · 副卡组 {String(cfg.sideMax)} · 选牌限时 {String(cfg.pickSeconds)} 秒
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs">
          {pack && (
            <div className="flex items-center gap-3 text-slate-200">
              <span>
                第 <b className="text-gold">{pack.index + 1}</b> 堆 / 共 {pack.packsRemaining + pack.index} 堆
              </span>
              <span>
                剩余 <b>{pack.cardsLeft}</b> 张
              </span>
              <span>
                正在选牌：<b className="text-gold">{pickerName}</b>
              </span>
              {pack.isMyTurn && secondsLeft !== null && (
                <span className={`rounded px-2 py-0.5 font-mono ${secondsLeft <= 5 ? 'bg-red-900 text-red-100' : 'bg-felt-edge text-gold'}`}>
                  {secondsLeft} 秒
                </span>
              )}
            </div>
          )}
          <IdentityWidget tid={tid} pid={pid} token={token} />
          <LocalPicsSetting />
          <FontSizeSetting />
        </div>
      </div>
    </header>
  );
}

export function DeckZone({ title, zone, codes, limit, cardMap, onCardDrop, onCardPick, onCardMove }: {
  title: string;
  zone: 'main' | 'extra' | 'side';
  codes: number[];
  limit?: string;
  cardMap?: Record<number, CardInfo>;
  onCardDrop?: (code: number) => void;
  onCardPick?: (code: number, zone: 'main' | 'extra' | 'side') => void;
  onCardMove?: (code: number, from: string, to: string) => void;
}) {
  const draggable = !!onCardMove || !!onCardDrop;
  const acceptsDrop = !!onCardPick || !!onCardMove || !!onCardDrop;
  return (
    <section
      onDragOver={(e) => acceptsDrop && e.preventDefault()}
      onDrop={acceptsDrop ? (e) => {
        e.preventDefault();
        const code = Number(e.dataTransfer.getData('text/plain'));
        if (!code) return;
        const zoneKind = e.dataTransfer.getData('application/x-card-zone');
        if (zoneKind === 'pack') {
          onCardPick?.(code, zone);
        } else if (zoneKind === 'deck') {
          const from = e.dataTransfer.getData('application/x-card-source') || 'pool';
          onCardMove?.(code, from, zone);
        } else {
          onCardDrop?.(code);
        }
      } : undefined}
      className="rounded-lg border border-felt-edge bg-felt/60 p-2"
    >
      <header className="mb-1 flex items-center justify-between text-xs text-slate-300">
        <span className="font-semibold">{title}</span>
        <span className="font-mono text-gold">
          {codes.length}
          {limit ? ` / ${limit}` : ''}
        </span>
      </header>
      <div className="card-grid">
        {codes.map((c, i) => (
          <div
            key={`${c}-${i}`}
            draggable={draggable}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', String(c));
              e.dataTransfer.setData('application/x-card-zone', 'deck');
              e.dataTransfer.setData('application/x-card-source', zone);
            }}
            className="cursor-grab active:cursor-grabbing"
          >
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
