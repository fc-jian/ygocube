'use client';

import { useRef, useState } from 'react';
import type { DeckIssue } from '@ygocube/shared';
import { isExtraDeckType } from '@/lib/cardInfo';
import type { CardInfo } from '@/lib/types';
import { workflowText } from './tournament-workflow-text';

export function DeckFeedback({ issues, available, side, cardMap, move, retry, locale = 'zh' }: {
  issues: DeckIssue[]; available: number[]; side: number[]; cardMap: Record<number, CardInfo>;
  move: (code: number, from: 'side' | 'pool', to: 'main') => Promise<void>;
  retry: () => Promise<void>; locale?: keyof typeof workflowText;
}) {
  const text = workflowText[locale];
  const moving = useRef(false);
  const [busy, setBusy] = useState(false);
  async function add(code: number, from: 'side' | 'pool') {
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    try { await move(code, from, 'main'); }
    finally { moving.current = false; setBusy(false); }
  }
  if (!issues.length) return <p className="text-sm text-emerald-200" role="status">{text.deckReady}</p>;
  const labels = { 'wrong-zone': text.wrongZone, name_limit: text.nameLimit, quantity: text.quantity, unpicked: text.unpicked };
  const entries = new Set<string>();
  for (const issue of issues) {
    if (issue.reason === 'too-many') entries.add(text.excess(text.zones[issue.zone], issue.actual - issue.limit));
    if ('code' in issue) entries.add(`${text.zones[issue.zone]} · ${cardMap[issue.code]?.name || '#' + issue.code} · ${labels[issue.reason]}`);
  }
  const shortage = issues.find((issue) => issue.reason === 'too-few');
  const missing = shortage && 'limit' in shortage ? shortage.limit - shortage.actual : 0;
  const sideEligible = [...side];
  for (const issue of issues) {
    if (issue.zone === 'side' && 'code' in issue) {
      const index = sideEligible.indexOf(issue.code);
      if (index >= 0) sideEligible.splice(index, 1);
    }
  }
  const candidates = [...new Set([...sideEligible, ...available])].filter((code) => cardMap[code] && !isExtraDeckType(cardMap[code].type));
  return <section aria-label={text.deckCheck} className="rounded border border-amber-700/60 bg-felt-deep p-3 text-sm">
    {missing > 0 && <details>
      <summary className="cursor-pointer text-amber-200">{text.missing(text.zones.main, missing)} · {text.showAvailable}</summary>
      <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto">
        {candidates.map((code) => {
          const from = sideEligible.includes(code) ? 'side' : 'pool';
          return <li className="flex items-center justify-between gap-2" key={code}>
            <span>{cardMap[code].name} <small className="text-slate-400">{text.zones[from]}</small></span>
            <button type="button" className="shrink-0 rounded bg-felt-edge px-2 py-1 disabled:opacity-50" disabled={busy}
              aria-label={`${text.add} · ${cardMap[code].name}`} onClick={() => void add(code, from)}>{text.add}</button>
          </li>;
        })}
      </ul>
      {!candidates.length && <p className="mt-1 text-slate-300">
        {[...sideEligible, ...available].some((code) => !cardMap[code])
          ? <>{text.checking} <button className="underline" onClick={() => void retry()}>{text.retry}</button></> : text.noAvailable}
      </p>}
    </details>}
    {!!entries.size && <ul className="list-inside list-disc text-amber-200">{[...entries].map((line) => <li key={line}>{line}</li>)}</ul>}
  </section>;
}
