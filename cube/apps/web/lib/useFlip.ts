'use client';

import { useLayoutEffect, useRef } from 'react';

// Dependency-free FLIP animation helper.
// Call snapshot() right before a mutation that will re-render the container;
// after React commits, every [data-flip-id] element that existed in the
// snapshot animates from its old position to its new one (Web Animations API).
// Elements that appear/disappear are skipped (they can fade in via CSS).
export function useFlip<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const pending = useRef<Map<string, { left: number; top: number }> | null>(null);

  const snapshot = () => {
    const root = ref.current;
    if (!root) return;
    const map = new Map<string, { left: number; top: number }>();
    root.querySelectorAll('[data-flip-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      map.set(el.getAttribute('data-flip-id')!, { left: r.left, top: r.top });
    });
    pending.current = map;
  };

  useLayoutEffect(() => {
    const root = ref.current;
    const before = pending.current;
    pending.current = null;
    if (!root || !before) return;
    root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((el) => {
      const old = before.get(el.getAttribute('data-flip-id')!);
      if (!old) return;
      const r = el.getBoundingClientRect();
      const dx = old.left - r.left;
      const dy = old.top - r.top;
      if (dx === 0 && dy === 0) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 200,
        easing: 'ease-out',
      });
    });
  });

  return { ref, snapshot };
}

// Stable per-card flip id: duplicate codes are disambiguated by occurrence index.
export function flipIds(zone: string, codes: number[]): string[] {
  const seen = new Map<number, number>();
  return codes.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return `${zone}:${c}:${n}`;
  });
}
