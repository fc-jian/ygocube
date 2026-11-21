'use client';

import type { AdminDraftHistory, AdminDraftSummary } from '@ygocube/shared';
import { useEffect, useState } from 'react';
import { readableApiError } from '@/lib/api';
import { workflowText } from './tournament-workflow-text';

const text = workflowText.zh;
type FetchAdmin = (path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
type HistoryProps = { tid: number; revision: number; fetchAdmin: FetchAdmin };
type EventRow = { seq: number; createdAt: string; summary: string; detail: string; actor?: string };

function useDetail<T>(path: string | null, revision: number, fetchAdmin: FetchAdmin) {
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{ path: string; key: string; data?: T; error?: string }>();
  const key = JSON.stringify([path, revision, attempt]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void fetchAdmin(path, 'GET', undefined, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ path, key, data: data as T }); },
      (error) => {
        if (!controller.signal.aborted) setResult(previous => ({
          path, key, data: previous?.path === path ? previous.data : undefined, error: readableApiError(error),
        }));
      },
    );
    return () => controller.abort();
  }, [key, path, fetchAdmin]);
  const current = result?.path === path ? result : undefined;
  const ready = current?.key === key && !current.error;
  const status = current?.key === key && current.error
    ? <p role="alert">{current.error} <button type="button" className="underline" onClick={() => retry(n => n + 1)}>{text.retry}</button></p>
    : !current?.data && path ? <p role="status">{text.loadDetail}</p> : null;
  return { data: current?.data, status, ready };
}

function DraftDetail({ tid, revision, summary, fetchAdmin }: HistoryProps & { summary: AdminDraftSummary }) {
  const [selected, select] = useState('');
  const packs = (summary.packSummary ?? []).map(p => ({ value: `pack=${p.index}`, label: text.packSize(p.index + 1, p.size) }));
  const players = summary.pickSummary.map(p => ({ value: `player=${encodeURIComponent(p.playerId)}`, label: p.playerId }));
  const options = [...packs, ...players];
  const value = options.some(o => o.value === selected) ? selected : options[0]?.value;
  const { data, status } = useDetail<AdminDraftHistory>(value ? `/admin/t/${tid}/draft-history?${value}` : null, revision, fetchAdmin);
  if (!value) return <p>{text.noHistory}</p>;
  return <>
    <label className="my-2 flex flex-wrap items-center gap-2">{text.selectHistory}
      <select className="max-w-full rounded bg-felt-deep p-1" value={value} onChange={e => select(e.target.value)}>
        {[{ label: text.byPack, rows: packs }, { label: text.byPlayer, rows: players }].map(({ label, rows }) =>
          rows.length > 0 && <optgroup key={label} label={label}>
            {rows.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>)}
      </select>
    </label>
    {status}
    {data?.pack && <p className="break-words">{text.originalOrder} · {data.pack.order.join(' · ')}
      {data.pack.dropCard != null && <span>（{text.dropped} {data.pack.dropCard}）</span>}</p>}
    {data && (data.picks.length ? <ol className="mt-2 max-h-72 space-y-1 overflow-auto">
      {data.picks.map((pick, i) => <li key={i}>{text.pack} {pick.packIndex + 1} · {text.hand} {pick.round} · {pick.playerId} · {pick.card} · {pick.auto ? text.auto : text.manual}</li>)}
    </ol> : <p>{text.emptyPicks}</p>)}
  </>;
}

function EventTimeline({ tid, revision, fetchAdmin, revert }: HistoryProps & { revert: (seq: number) => void }) {
  const { data, status, ready } = useDetail<EventRow[]>(`/admin/t/${tid}/events`, revision, fetchAdmin);
  const [selected, select] = useState<number | null>(null);
  const [hovered, hover] = useState<number | null>(null);
  const selectedEvent = data?.find(e => e.seq === selected);
  const detail = data?.find(e => e.seq === hovered) ?? selectedEvent;
  return <>{status}{data && <>
    <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
      {data.map(e => <button type="button" key={e.seq} aria-pressed={selected === e.seq}
        onClick={() => select(e.seq)} onMouseEnter={() => hover(e.seq)} onMouseLeave={() => hover(null)}
        className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-felt-deep ${selected === e.seq ? 'bg-gold/20 ring-1 ring-gold' : ''}`}>
        <span className="w-14 shrink-0 font-mono text-slate-400">{e.seq}</span>
        <span className="w-16 shrink-0 font-mono text-slate-500">{new Date(e.createdAt).toLocaleTimeString()}</span>
        <span className="truncate">{e.summary}</span>{e.actor && <span>· {e.actor}</span>}
      </button>)}
      {!data.length && <p className="py-2 text-center text-slate-500">{text.noEvents}</p>}
    </div>
    {detail && <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-felt-deep/70 p-2">{detail.detail}</pre>}
    <div className="mt-2 flex items-center gap-2"><span>{selectedEvent ? `seq ${selectedEvent.seq}` : text.noSelection}</span>
      <button type="button" disabled={!ready || !selectedEvent} onClick={() => ready && selectedEvent && revert(selectedEvent.seq)}
        className="rounded bg-gold px-2 py-1 font-semibold text-felt-deep disabled:opacity-40">{text.revertHere}</button>
    </div>
  </>}</>;
}

export function AdminHistory({ tid, summary, fetchAdmin, revert }: {
  tid: number; summary: AdminDraftSummary; fetchAdmin: FetchAdmin; revert: (seq: number) => void;
}) {
  const [draftOpen, openDraft] = useState(false);
  const [eventsOpen, openEvents] = useState(false);
  const props = { tid, revision: summary.lastEventSeq, fetchAdmin };
  return <div className="space-y-2 text-xs">
    <details className="rounded-lg border border-felt-edge bg-felt/60 p-3" onToggle={e => openDraft(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold text-gold">{text.draftDetail}</summary>
      {draftOpen && <DraftDetail {...props} summary={summary} />}
    </details>
    <details className="rounded-lg border border-felt-edge bg-felt/60 p-3" onToggle={e => openEvents(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold text-gold">{text.timeline}</summary>
      {eventsOpen && <EventTimeline {...props} revert={revert} />}
    </details>
  </div>;
}
