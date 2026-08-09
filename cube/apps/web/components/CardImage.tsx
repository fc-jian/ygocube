'use client';

import { useEffect, useState } from 'react';
import { CardInfo } from '@/lib/types';
import { getDirHandle, readCardImageUrl, requestDirPermission } from '@/lib/pics';

// 卡图组件（dev_docs/06 §5）：优先读取用户显式授权的本地目录句柄（showDirectoryPicker，
// 相对路径 pics/ 与 expansions/*/pics/），其次手动配置的本地路径（HTTP 无法列目录，
// 只尝试 pics/ 与 expansions/pics/），再回退服务端低清 avif（/api/pics/:code.avif）
// 与服务端原图代理（/api/pics/:code），最终空白卡占位。
export function CardImage({ code, name, className = '' }: { code: number; name?: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fallback = async () => {
      const candidates: string[] = [];
      const root = localStorage.getItem('yc_local_pics');
      if (root) {
        const base = root.replace(/\/+$/, '');
        candidates.push(`${base}/pics/${code}.jpg`, `${base}/expansions/pics/${code}.jpg`);
      }
      candidates.push(`/api/pics/${code}.avif`, `/api/pics/${code}`);
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
            const url = await readCardImageUrl(handle, code);
            if (url) {
              if (!cancelled) setSrc(url);
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
    };
  }, [code]);

  if (src) {
    return <img src={src} alt={name ?? String(code)} className={`rounded-md border border-white/10 object-cover shadow-[0_5px_14px_rgba(0,0,0,0.28)] ${className}`} loading="lazy" />;
  }
  return (
    <div
      className={`flex items-center justify-center rounded-md border border-slate-600/70 bg-gradient-to-b from-slate-700 to-slate-950 p-1 text-center shadow-[0_5px_14px_rgba(0,0,0,0.28)] ${className}`}
    >
      <span className="line-clamp-3 break-all text-[0.625rem] leading-tight text-slate-300">{name ?? code}</span>
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
      className={`group relative ${className}`}
      onMouseEnter={(e) => card && showCardPreview(card, e)}
      onMouseMove={(e) => card && moveCardPreview(e)}
      onClick={(e) => card && pinOnClick && pinCardPreview(card, e)}
      onMouseLeave={() => hideCardPreview()}
    >
      <CardImage code={code} name={card?.name} className="aspect-[7/10] w-full" />
    </div>
  );
}
