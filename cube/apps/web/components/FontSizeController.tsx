'use client';

import { useEffect } from 'react';

// 全局字号控制（小/中/大；默认中=16px，通过根字号缩放 Tailwind rem）
const SIZES = { small: '14px', medium: '16px', large: '18px' } as const;
export type FontSizeKey = keyof typeof SIZES;

export function FontSizeController() {
  useEffect(() => {
    const apply = (key: string | null) => {
      const k = key === 'small' || key === 'medium' || key === 'large' ? key : 'medium';
      document.documentElement.style.fontSize = SIZES[k];
    };
    apply(localStorage.getItem('yc_font_size'));
    const onStorage = () => apply(localStorage.getItem('yc_font_size'));
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}

export function FontSizeSetting() {
  const current = (typeof window !== 'undefined' && localStorage.getItem('yc_font_size')) || 'medium';
  const setSize = (k: FontSizeKey) => {
    localStorage.setItem('yc_font_size', k);
    document.documentElement.style.fontSize = SIZES[k];
  };
  return (
    <div className="flex items-center gap-1 text-xs text-slate-400">
      <span>字号</span>
      {(['small', 'medium', 'large'] as const).map((k) => (
        <button
          key={k}
          onClick={() => setSize(k)}
          className={`rounded px-2 py-1 ${current === k ? 'bg-gold text-felt-deep font-semibold' : 'bg-felt-edge hover:brightness-110'}`}
        >
          {k === 'small' ? '小' : k === 'medium' ? '中' : '大'}
        </button>
      ))}
    </div>
  );
}
