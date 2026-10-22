'use client';

import { useEffect } from 'react';

// 全局字号控制（小/中/大；默认中=16px，通过根字号缩放 Tailwind rem）
const SIZES = { small: '14px', medium: '16px', large: '18px' } as const;
export type FontSizeKey = keyof typeof SIZES;

function readFontSize(): FontSizeKey {
  try {
    const key = typeof window !== 'undefined' ? window.localStorage.getItem('yc_font_size') : null;
    if (key === 'small' || key === 'medium' || key === 'large') return key;
  } catch { /* Browser storage is optional for presentation preferences. */ }
  return 'medium';
}

export function FontSizeController() {
  useEffect(() => {
    const apply = (key: string | null) => {
      const k = key === 'small' || key === 'medium' || key === 'large' ? key : 'medium';
      document.documentElement.style.fontSize = SIZES[k];
    };
    apply(readFontSize());
    const onStorage = () => apply(readFontSize());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}

export function FontSizeSetting() {
  const current = readFontSize();
  const setSize = (k: FontSizeKey) => {
    try { window.localStorage.setItem('yc_font_size', k); }
    catch { /* Apply the size for this page even when it cannot be persisted. */ }
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
