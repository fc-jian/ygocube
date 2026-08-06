'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, apiDownload, Identity, resolvePlayerIdentity } from '@/lib/api';
import { useTournamentStream } from '@/lib/sse';
import { DeckZone, DraftState, useNowTick } from '@/components/TopBar';
import { CardWithTooltip } from '@/components/CardImage';
import { CardSearch } from '@/components/CardSearch';
import { closeCardPreview, setCardPreviewAction } from '@/components/CardPreview';
import { TokenPrompt } from '@/components/TokenPrompt';
import { CardInfo } from '@/lib/types';

export default function DeckPage() {
  const params = useParams<{ tid: string; pid: string }>();
  const tid = params.tid;
  const pid = params.pid;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [notJoined, setNotJoined] = useState(false);
  const [state, setState] = useState<DraftState | null>(null);
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState<number[]>([]);

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
      const used = new Set([...(s.deck?.main ?? []), ...(s.deck?.extra ?? []), ...(s.deck?.side ?? [])]);
      setDiscard((s.pickedCards ?? []).filter((c) => !used.has(c)));
      const codes = new Set<number>([...(s.pickedCards ?? [])]);
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

  useEffect(() => {
    void load();
  }, [load]);

  useTournamentStream(tid, identity, useCallback(() => void load(), [load]));
  const now = useNowTick(true);

  const move = async (card: number, from: string, to: string) => {
    try {
      await api(`/t/${tid}/deck/move`, { method: 'POST', body: { card_code: card, from, to }, identity });
      await load();
    } catch (e: any) {
      setError(e.code === 'WRONG_ZONE' ? '该类型卡不能放入此区域' : (e.code ?? String(e)));
    }
  };

  const lock = async () => {
    try {
      await api(`/t/${tid}/deck/lock`, { method: 'POST', identity });
      await load();
    } catch (e: any) {
      setError(e.details ? (e.details as string[]).join('；') : (e.code ?? String(e)));
    }
  };

  // 固定预览的快捷操作：主/额外 <-> 副卡组、移出构筑（回到未使用区）；
  // 操作执行后立即关闭详情窗口（dev_docs/06 §4）
  useEffect(() => {
    if (!state || !identity) return;
    const act = (card: number, from: string, to: string) => {
      void move(card, from, to);
      closeCardPreview();
    };
    setCardPreviewAction((card) => {
      const inSide = state.deck?.side?.includes(card.code);
      const inMain = state.deck?.main?.includes(card.code);
      const inExtra = state.deck?.extra?.includes(card.code);
      if (inSide) return { label: '移动到主卡组', run: () => act(card.code, 'side', 'main') };
      if (inMain || inExtra)
        return {
          label: '移动到副卡组',
          run: () => act(card.code, inExtra ? 'extra' : 'main', 'side'),
          secondary: { label: '移出构筑', run: () => act(card.code, inExtra ? 'extra' : 'main', 'pool') },
        };
      return null;
    });
    return () => setCardPreviewAction(null);
  }, [state, identity, tid, move]);

  const unlock = async () => {
    try {
      await api(`/t/${tid}/deck/unlock`, { method: 'POST', identity });
      await load();
    } catch (e: any) {
      setError(e.code ?? String(e));
    }
  };

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
  if (!state || !identity) return <main className="p-8 text-slate-400">加载中...</main>;

  const deck = state.deck ?? { main: [], extra: [], side: [], lockedAt: null };
  const locked = !!deck.lockedAt;
  const cfg = state.config;
  const buildSecondsLeft = state.phaseDeadline ? Math.max(0, Math.ceil((new Date(state.phaseDeadline).getTime() - now) / 1000)) : null;

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-felt-edge bg-felt px-4 py-2 text-sm text-slate-200">
        <span>
          构筑卡组 — {state.players.find((p) => p.playerId === pid)?.displayName ?? pid}
          {locked && <span className="ml-3 rounded bg-gold px-2 py-0.5 text-xs text-felt-deep">已锁定</span>}
          {buildSecondsLeft !== null && !locked && (
            <span className={`ml-3 rounded px-2 py-0.5 font-mono text-xs ${buildSecondsLeft <= 60 ? 'bg-red-900 text-red-100' : 'bg-felt-edge text-gold'}`}>
              剩余 {Math.floor(buildSecondsLeft / 60)} 分 {buildSecondsLeft % 60} 秒
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 text-xs">
          <a href={`/t/${tid}/draft/${pid}`} className="rounded bg-felt-edge px-2 py-0.5 hover:brightness-110">
            返回选牌
          </a>
          {state.status === 'matches' && (
            <a href={`/t/${tid}/matches/${pid}`} className="rounded bg-felt-edge px-2 py-0.5 text-gold hover:brightness-110">
              前往对战
            </a>
          )}
        </span>
      </header>
      <div className="flex flex-1 gap-3 overflow-hidden p-3">
        <div className="flex w-3/5 flex-col gap-2 overflow-y-auto pr-1">
          <DeckZone title="主卡组" zone="main" codes={deck.main} limit={`${cfg.mainMin}-${cfg.mainMax}`} cardMap={cardMap} onCardMove={(c, f) => move(c, f, 'main')} />
          <DeckZone title="额外卡组" zone="extra" codes={deck.extra} limit={String(cfg.extraMax)} cardMap={cardMap} onCardMove={(c, f) => move(c, f, 'extra')} />
          <DeckZone title="副卡组" zone="side" codes={deck.side} limit={String(cfg.sideMax)} cardMap={cardMap} onCardMove={(c, f) => move(c, f, 'side')} />
        </div>
        <aside
          className="flex flex-1 flex-col gap-2 overflow-y-auto"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const code = Number(e.dataTransfer.getData('text/plain'));
            const zoneKind = e.dataTransfer.getData('application/x-card-zone');
            const from = e.dataTransfer.getData('application/x-card-source');
            if (code && zoneKind === 'deck' && from && from !== 'pool') {
              void move(code, from, 'pool'); // 拖到未使用区 = 移出构筑
            }
          }}
        >
          <CardSearch tid={tid} identity={identity} pool={discard} onAdd={(c) => void move(c, 'pool', 'side')} />
          <div className="flex-1 rounded-lg border border-felt-edge bg-felt/60 p-2">
            <header className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-300">
              <span>未使用卡池（{discard.length}）</span>
              <span className="font-normal text-slate-500">可拖入此处移出构筑</span>
            </header>
            <div className="card-grid-5">
              {discard.map((c, i) => (
                <div
                  key={i}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', String(c));
                    e.dataTransfer.setData('application/x-card-zone', 'deck');
                    e.dataTransfer.setData('application/x-card-source', 'pool');
                  }}
                  className="cursor-grab active:cursor-grabbing"
                >
                  {/* 卡图 + hover/点击详情（无本地图时仍可查看卡牌效果） */}
                  <CardWithTooltip code={c} card={cardMap[c]} />
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
      <footer className="flex items-center justify-between border-t border-felt-edge bg-felt px-4 py-2">
        <button
          onClick={() => void apiDownload(`/t/${tid}/deck.ydk`, identity).catch(() => setError('下载失败'))}
          className="rounded bg-felt-edge px-4 py-1.5 text-sm hover:brightness-110"
        >
          下载 ydk
        </button>
        {state.status !== 'deckbuilding' ? (
          <span className="text-xs text-slate-500">对战已开始，卡组已锁定不可修改</span>
        ) : locked ? (
          <button onClick={unlock} className="rounded bg-red-900 px-4 py-1.5 text-sm text-red-100 hover:brightness-110">
            解锁卡组
          </button>
        ) : (
          <button onClick={lock} className="animate-lock rounded bg-gold px-4 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110">
            锁定卡组
          </button>
        )}
      </footer>
      {error && <div className="mx-3 mb-2 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200">{error}</div>}
    </main>
  );
}
