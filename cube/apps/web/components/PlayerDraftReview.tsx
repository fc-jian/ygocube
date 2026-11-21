'use client';

import { useEffect, useState } from 'react';
import type { DraftReview } from '@ygocube/shared';
import { api, encodePathSegment, type Identity } from '@/lib/api';
import { workflowText } from './tournament-workflow-text';

export function PlayerDraftReview({ identity, locale = 'zh' }: { identity: Identity; locale?: keyof typeof workflowText }) {
  const text = workflowText[locale];
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DraftReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  useEffect(() => { if (window.location.hash === '#draft-review') setOpen(true); }, []);
  useEffect(() => {
    if (!open || data) return;
    const controller = new AbortController();
    setFailed(false);
    api<DraftReview>(`/t/${encodePathSegment(identity.tid)}/draft-review`, { identity, signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setData(response); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, data, identity, attempt]);
  const hand = data?.hands[index];
  const name = (code: number) => data?.names[code] || `#${code}`;
  const buttonClass = 'rounded bg-felt-edge px-3 py-1.5 text-sm disabled:opacity-40';
  return <section id="draft-review" className="mb-4 rounded-lg border border-felt-edge bg-felt/60 p-3">
    <button type="button" className="font-semibold text-gold" aria-expanded={open} aria-controls="draft-review-hands"
      onClick={() => setOpen(!open)}>{open ? text.close : text.review}</button>
    {open && <div id="draft-review-hands" className="mt-3">
      {failed ? <p role="alert">{text.reviewError} <button className="underline" onClick={() => setAttempt((n) => n + 1)}>{text.retry}</button></p>
        : !data ? <p role="status">{text.loading}</p> : !hand ? <p>{text.emptyReview}</p> : <>
          <nav className="flex flex-wrap items-center gap-2" aria-label={text.hand}>
            <button className={buttonClass} disabled={index === 0} onClick={() => setIndex(index - 1)}>{text.previous}</button>
            <label>{text.hand} <select className="rounded bg-felt-deep px-2 py-1" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {data.hands.map((_, i) => <option key={i} value={i}>{i + 1} / {data.hands.length}</option>)}
            </select></label>
            <button className={buttonClass} disabled={index === data.hands.length - 1} onClick={() => setIndex(index + 1)}>{text.next}</button>
          </nav>
          <p className="my-2 text-sm text-slate-300">{hand.draftRound && `${text.round} ${hand.draftRound} · `}{text.pack} {hand.packIndex + 1}</p>
          <p className="rounded bg-felt-deep p-2" aria-live="polite"><strong className="text-gold">{text.picked}</strong>
            {' · '}{hand.selected.map(name).join(' + ')} <small>({hand.auto ? text.auto : text.manual})</small></p>
          <h3 className="mb-1 mt-3 text-sm font-semibold">{text.options} ({hand.cards.length})</h3>
          <ul className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2">
            {hand.cards.map((code, i) => <li className="break-words" key={i}>{name(code)}</li>)}
          </ul>
        </>}
    </div>}
  </section>;
}
