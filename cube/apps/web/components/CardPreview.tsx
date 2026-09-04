'use client';

import { useEffect, useState } from 'react';
import { CardInfo } from '@/lib/types';
import { CardImage } from './CardImage';
import { aliasLine, atkDefLine, linkMarkerLine, raceAttrLine, setNameLine, statLine, typeLabel } from '@/lib/cardInfo';

// 全局浮动卡牌预览（ygopro 风格，position:fixed，不受容器 overflow 裁剪）。
// hover 显示；点击小窗可固化（可滚动/选择文本/复制），右上角关闭。
type PreviewState = { card: CardInfo; x: number; y: number } | null;
type PreviewAction = { label: string; run: () => void; secondary?: { label: string; run: () => void } } | null;
let setPreviewState: React.Dispatch<React.SetStateAction<PreviewState>> | null = null;
let previewAction: ((card: CardInfo) => PreviewAction) | null = null;
let pinnedRef = false;

function supportsFineHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

// 页面注册预览操作（如"移动到副卡组/主卡组"）
export function setCardPreviewAction(getAction: ((card: CardInfo) => PreviewAction) | null): void {
  previewAction = getAction;
}

export function showCardPreview(card: CardInfo, e: { clientX: number; clientY: number }): void {
  if (pinnedRef || !supportsFineHover()) return; // 触摸设备使用点击固定详情，不显示跟手 hover 窗口
  setPreviewState?.({ card, x: e.clientX, y: e.clientY });
}

// 点击卡牌：直接固定详情窗口
export function pinCardPreview(card: CardInfo, e: { clientX: number; clientY: number }): void {
  setPreviewState?.({ card, x: e.clientX, y: e.clientY });
  setPinnedState?.(true);
}

let setPinnedState: React.Dispatch<React.SetStateAction<boolean>> | null = null;

export function moveCardPreview(e: { clientX: number; clientY: number }): void {
  if (pinnedRef || !supportsFineHover()) return;
  setPreviewState?.((s) => (s ? { ...s, x: e.clientX, y: e.clientY } : s));
}

export function hideCardPreview(): void {
  if (pinnedRef) return; // 已固定的窗口不受 hover 离开影响
  setPreviewState?.(null);
}

// 程序化关闭固定窗口（移动卡牌等操作完成后收起详情）
export function closeCardPreview(): void {
  pinnedRef = false;
  setPinnedState?.(false);
  setPreviewState?.(null);
}

// Shared metadata block used by hover/pinned previews and the draft pick
// confirmation modal. Field hexadecimal codes remain searchable metadata, but
// are intentionally not exposed in player-facing card details.
export function CardMeta({ card, compact = false }: { card: CardInfo; compact?: boolean }) {
  const labelClass = compact ? 'text-[0.6875rem]' : 'text-sm';
  const smallClass = compact ? 'text-[0.625rem]' : 'text-xs';
  return (
    <>
      <p className={labelClass + ' text-slate-300'}>{typeLabel(card)}</p>
      {raceAttrLine(card) && <p className={labelClass + ' text-slate-300'}>{raceAttrLine(card)}</p>}
      {statLine(card) && <p className={labelClass + ' text-slate-300'}>{statLine(card)}</p>}
      {atkDefLine(card) && <p className={labelClass + ' font-semibold text-slate-100'}>{atkDefLine(card)}</p>}
      {linkMarkerLine(card) && <p className={labelClass + ' text-slate-300'}>{linkMarkerLine(card)}</p>}
      {setNameLine(card) && <p className={'mt-1 ' + smallClass + ' text-slate-400'}>{setNameLine(card)}</p>}
      {(card.pickStats ?? []).map((stat) => (
        <div key={stat.poolId} className={smallClass + ' text-amber-200/90'}>
          <p>{card.pickStats!.length > 1 ? `${stat.poolName} ` : ''}平均抓位：{stat.averagePickPosition.toFixed(2)}（{stat.averagePickPercentage.toFixed(2)}%）</p>
          <p>统计：{stat.packCount} 个牌包 · {stat.tournamentCount} 场比赛</p>
        </div>
      ))}
      {aliasLine(card) && <p className={smallClass + ' text-slate-500'}>{aliasLine(card)}</p>}
    </>
  );
}

export function CardPreviewHost() {
  const [preview, setPreview] = useState<PreviewState>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    setPreviewState = setPreview;
    setPinnedState = setPinned;
    return () => {
      setPreviewState = null;
      setPinnedState = null;
    };
  }, []);

  useEffect(() => {
    pinnedRef = pinned;
  }, [pinned]);

  // 固定后不再跟随鼠标；点击其他地方取消固定
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('[data-card-preview]')) {
        setPinned(false);
        setPreview(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setPreview(null);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [pinned]);

  if (!preview) return null;
  const { card, x, y } = preview;
  if (pinned) {
    // 固定模式：居中的模态窗口，点击外部任意处关闭
    return (
      <div
        className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
        onClick={() => {
          setPinned(false);
          setPreview(null);
        }}
      >
        <div
          data-card-preview
          role="dialog"
          aria-modal="true"
          aria-labelledby="card-preview-title"
          className="relative mx-2 max-h-[min(90dvh,90vh)] w-[min(420px,calc(100vw-1rem))] max-w-[92vw] overflow-y-auto rounded-lg border border-gold/50 bg-felt-deep p-3 shadow-2xl select-text sm:mx-4 sm:p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="关闭卡牌详情"
            onClick={() => {
              setPinned(false);
              setPreview(null);
            }}
            className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-lg text-slate-200 hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-gold"
          >
            ×
          </button>
          <div className="flex gap-4">
            <CardImage code={card.code} name={card.name} className="h-[clamp(9rem,32vh,13rem)] w-[clamp(6.5rem,24vw,9.5rem)] shrink-0" />
            <div className="min-w-0 flex-1">
              <p id="card-preview-title" className="pr-7 text-base font-bold leading-snug text-gold">{card.name}</p>
              <p className="mt-1 font-mono text-xs text-slate-500">[{String(card.code).padStart(8, '0')}]</p>
              <CardMeta card={card} />
            </div>
          </div>
          {card.desc && (
            <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-200">{card.desc}</p>
          )}
          {previewAction && (() => {
            const a = previewAction(card);
            return a ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // Moving a card is a terminal action for the details
                    // window.  Close here as a defensive default so newly
                    // registered actions cannot leave a stale overlay above
                    // the updated deck.
                    try {
                      a.run();
                    } finally {
                      closeCardPreview();
                    }
                  }}
                  className="flex-1 rounded bg-gold px-3 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110"
                >
                  {a.label}
                </button>
                {a.secondary && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      try {
                        a.secondary!.run();
                      } finally {
                        closeCardPreview();
                      }
                    }}
                    className="rounded bg-felt-edge px-3 py-1.5 text-sm text-slate-200 hover:brightness-110"
                  >
                    {a.secondary.label}
                  </button>
                )}
              </div>
            ) : null;
          })()}
        </div>
      </div>
    );
  }
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const compact = viewportWidth < 640;
  // Scale the preview with the viewport, then clamp it inside a safe gutter so
  // narrow phones and short laptop screens never render an off-screen card.
  const width = Math.min(viewportWidth - 16, compact ? 340 : Math.max(280, Math.min(360, viewportWidth * 0.3)));
  const maxHeight = Math.max(180, viewportHeight - (compact ? 24 : 32));
  const gap = compact ? 10 : 18;
  const rawLeft = x > viewportWidth / 2 ? x - width - gap : x + gap;
  const rawTop = y + gap + maxHeight <= viewportHeight - 8 ? y + gap : y - maxHeight - gap;
  const left = Math.max(8, Math.min(rawLeft, viewportWidth - width - 8));
  const top = Math.max(8, Math.min(rawTop, viewportHeight - maxHeight - 8));
  const style: React.CSSProperties = {
    position: 'fixed',
    left,
    top,
    width,
    maxHeight,
    zIndex: 1000,
  };
  return (
    <div
      data-card-preview
      style={style}
      className={`rounded-lg border border-gold/50 bg-felt-deep p-3 shadow-2xl ${pinned ? 'pointer-events-auto select-text' : 'pointer-events-none'}`}
      onClick={() => setPinned(true)}
      title="点击查看详情"
    >

      <div className="flex gap-3">
        <CardImage code={card.code} name={card.name} className="h-[clamp(7rem,30vw,9rem)] w-[clamp(5rem,22vw,6.5rem)] shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-snug text-gold">{card.name}</p>
          <p className="mt-0.5 font-mono text-[0.625rem] text-slate-500">[{String(card.code).padStart(8, '0')}]</p>
          <CardMeta card={card} compact />
        </div>
      </div>
      {card.desc && (
        <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-line text-[0.6875rem] leading-relaxed text-slate-200">
          {card.desc}
        </p>
      )}
    </div>
  );
}
