'use client';

import { observeCardViewport } from '@/lib/cardViewport';
import { API_BASE } from '@/lib/api';
import { useEffect, useRef, useState } from 'react';
import { CardInfo } from '@/lib/types';
import { getDirHandle, localCardImagePaths, readCardImageUrl, requestDirPermission } from '@/lib/pics';

// 卡图组件（dev_docs/06 §5）：优先读取用户显式授权的本地目录句柄（showDirectoryPicker，
// 自动查找 expansions/pics/、expansions/*/pics/ 与 pics/），其次手动配置的本地路径（HTTP 无法列目录，
// 优先 expansions/pics/，兼容常见图片格式），再回退服务端低清 avif（/api/pics/:code.avif）
// 与服务端原图代理（/api/pics/:code），最终空白卡占位。
export function CardImage({ code, name, className = '' }: { code: number; name?: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [visibleCode, setVisibleCode] = useState<number | null>(null);
  useEffect(() => {
    if (!container.current) return;
    return observeCardViewport(container.current, () => setVisibleCode(code));
  }, [code]);
  const [picsRevision, setPicsRevision] = useState(0);
  useEffect(()=>{const refresh=()=>setPicsRevision(v=>v+1);window.addEventListener('yc-pics-changed',refresh);return()=>window.removeEventListener('yc-pics-changed',refresh)},[]);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    if (visibleCode !== code) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const fallback = async () => {
      const candidates: string[] = [];
      const root = localStorage.getItem('yc_local_pics');
      if (root) {
        const base = root.replace(/\/+$/, '');
        candidates.push(...localCardImagePaths(code).map(path => `${base}/${path}`));
      }
      candidates.push(`${API_BASE}/pics/${code}.avif`, `${API_BASE}/pics/${code}`);
      let idx = 0;
      const tryNext = () => {
        if (cancelled || idx >= candidates.length) {
          if (!cancelled) setSrc(null);
          return;
        }
        const img = new Image();
        img.onload = () => {
          if (!cancelled) setSrc(candidates[idx]);
        };
        img.onerror = () => {
          idx++;
          tryNext();
        };
        img.src = candidates[idx];
      };
      tryNext();
    };
    (async () => {
      try {
        const handle = await getDirHandle();
        if (handle) {
          if (await requestDirPermission(handle)) {
            const url = await readCardImageUrl(handle, code, (candidate) => new Promise<boolean>((resolve) => {
              const image = new Image();
              image.onload = () => resolve(image.naturalWidth > 0);
              image.onerror = () => resolve(false);
              image.src = candidate;
            }));
            if (url) {
              if (!cancelled) {
                objectUrl = url;
                setSrc(url);
              } else {
                URL.revokeObjectURL(url);
              }
              return;
            }
          }
        }
      } catch {
        // fall through to proxy
      }
      await fallback();
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [code, picsRevision, visibleCode]);

  return (
    <div
      ref={container}
      data-card-image
      data-card-code={code}
      className={`relative aspect-[7/10] object-cover rounded-md border border-white/10 shadow-[0_5px_14px_rgba(0,0,0,0.28)] ${className}`}
    >
      {/* Keep searchable text in layout even before the image is loaded. Do not
          use display:none/visibility:hidden: browser Find must reach this card. */}
      <span data-card-search aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden text-[10px] text-transparent">
        {name ?? ''} {String(code).padStart(8, '0')}
      </span>
      {src && visibleCode === code ? (
        <img draggable={false} data-card-code={code} src={src} alt={name ?? String(code)}
          className="absolute inset-0 h-full w-full rounded-md" style={{ objectFit: 'inherit' }} loading="lazy" />
      ) : (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-gradient-to-b from-slate-700 to-slate-950 p-1 text-center">
          <span className="line-clamp-3 break-all text-[0.625rem] leading-tight text-slate-300">{name ?? code}</span>
        </span>
      )}
    </div>
  );
}

// 悬停触发全局浮动预览；点击卡牌则固定该详情窗口（可滚动/复制），再次点击空白处关闭。
import { hideCardPreview, moveCardPreview, pinCardPreview, showCardPreview } from './CardPreview';

export function CardWithTooltip({ code, card, className = '', pinOnClick = true }: {
  code: number;
  card?: CardInfo;
  className?: string;
  // 关闭点击固定详情：父容器自带点击行为（如牌堆选牌确认）时避免弹出双重窗口
  pinOnClick?: boolean;
}) {
  return (
    <div
      data-card-code={code}
      className={`group relative ${className}`}
      role={pinOnClick ? 'button' : undefined}
      tabIndex={pinOnClick ? 0 : undefined}
      aria-label={pinOnClick ? `查看${card?.name ?? code}详情` : undefined}
      onMouseEnter={(e) => card && showCardPreview(card, e)}
      onMouseMove={(e) => card && moveCardPreview(e)}
      onClick={(e) => card && pinOnClick && pinCardPreview(card, e)}
      onKeyDown={(e) => {
        if (card && pinOnClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          pinCardPreview(card, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
        }
      }}
      onMouseLeave={() => hideCardPreview()}
    >
      <CardImage code={code} name={card?.name} className="aspect-[7/10] w-full" />
    </div>
  );
}
