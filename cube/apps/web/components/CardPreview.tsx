'use client';

import { useEffect, useState } from 'react';
import { CardInfo } from '@/lib/types';
import { CardImage } from './CardImage';
import { atkDefLine, raceAttrLine, statLine, typeLabel } from '@/lib/cardInfo';

// 全局浮动卡牌预览（ygopro 风格，position:fixed，不受容器 overflow 裁剪）。
// hover 显示；点击小窗可固化（可滚动/选择文本/复制），右上角关闭。
type PreviewState = { card: CardInfo; x: number; y: number } | null;
type PreviewAction = { label: string; run: () => void; secondary?: { label: string; run: () => void } } | null;
let setPreviewState: React.Dispatch<React.SetStateAction<PreviewState>> | null = null;
let previewAction: ((card: CardInfo) => PreviewAction) | null = null;
let pinnedRef = false;

// 页面注册预览操作（如"移动到副卡组/主卡组"）
export function setCardPreviewAction(getAction: ((card: CardInfo) => PreviewAction) | null): void {
  previewAction = getAction;
}

export function showCardPreview(card: CardInfo, e: { clientX: number; clientY: number }): void {
  if (pinnedRef) return; // 已固定详情时不再被 hover 顶替（避免双重窗口）
  setPreviewState?.({ card, x: e.clientX, y: e.clientY });
}

// 点击卡牌：直接固定详情窗口
export function pinCardPreview(card: CardInfo, e: { clientX: number; clientY: number }): void {
  setPreviewState?.({ card, x: e.clientX, y: e.clientY });
  setPinnedState?.(true);
}

let setPinnedState: React.Dispatch<React.SetStateAction<boolean>> | null = null;

export function moveCardPreview(e: { clientX: number; clientY: number }): void {
  if (pinnedRef) return;
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
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
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
          className="mx-4 max-h-[90vh] w-[420px] max-w-[92vw] overflow-y-auto rounded-lg border border-gold/50 bg-felt-deep p-4 shadow-2xl select-text"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex gap-4">
            <CardImage code={card.code} name={card.name} className="h-52 w-38 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold leading-snug text-gold">{card.name}</p>
              <p className="mt-1 font-mono text-xs text-slate-500">#{card.code}</p>
              <p className="mt-2 text-sm text-slate-300">{typeLabel(card)}</p>
              {raceAttrLine(card) && <p className="text-sm text-slate-300">{raceAttrLine(card)}</p>}
              {statLine(card) && <p className="text-sm text-slate-300">{statLine(card)}</p>}
              {atkDefLine(card) && <p className="text-sm font-semibold text-slate-100">{atkDefLine(card)}</p>}
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
                    a.run();
                  }}
                  className="flex-1 rounded bg-gold px-3 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110"
                >
                  {a.label}
                </button>
                {a.secondary && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      a.secondary!.run();
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
  const flip = x > window.innerWidth - 320;
  const flipY = y > window.innerHeight - 560;
  const style: React.CSSProperties = {
    position: 'fixed',
    left: flip ? x - 300 : x + 18,
    top: flipY ? y - 520 : y + 18,
    width: 300,
    maxHeight: 'calc(100vh - 40px)',
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
        <CardImage code={card.code} name={card.name} className="h-36 w-26 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-snug text-gold">{card.name}</p>
          <p className="mt-0.5 font-mono text-[0.625rem] text-slate-500">#{card.code}</p>
          <p className="mt-1 text-[0.6875rem] text-slate-300">{typeLabel(card)}</p>
          {raceAttrLine(card) && <p className="text-[0.6875rem] text-slate-300">{raceAttrLine(card)}</p>}
          {statLine(card) && <p className="text-[0.6875rem] text-slate-300">{statLine(card)}</p>}
          {atkDefLine(card) && <p className="text-[0.6875rem] font-semibold text-slate-100">{atkDefLine(card)}</p>}
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
