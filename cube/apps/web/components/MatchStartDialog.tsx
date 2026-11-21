'use client';

import type { DeckIssue, MatchStartPreview } from '@ygocube/shared';
import { ConfirmModal } from './ConfirmModal';
import { workflowText } from './tournament-workflow-text';

const text = workflowText.zh;
function issueLabel(issue: DeckIssue) {
  const zone = text.zones[issue.zone];
  if ('limit' in issue) return issue.reason === 'too-few'
    ? text.missing(zone, issue.limit - issue.actual) : text.excess(zone, issue.actual - issue.limit);
  const message = { 'wrong-zone': text.wrongZone, name_limit: text.nameLimit, quantity: text.quantity, unpicked: text.unpicked };
  return `${zone} · ${issue.code} · ${message[issue.reason]}`;
}

export function MatchStartDialog({ preview, changed, error, busy, cancelText, cancel, confirm }: {
  preview: MatchStartPreview; changed: boolean; error?: string; busy: boolean; cancelText: string; cancel: () => void; confirm: () => void;
}) {
  const groups = [
    { title: text.disqualified, decks: preview.invalid_decks.filter((deck) => deck.mainShortfall > 0) },
    { title: text.autoRepair, decks: preview.invalid_decks.filter((deck) => deck.mainShortfall === 0) },
  ];
  return <ConfirmModal open title={text.preflight} cancelText={cancelText} confirmText={text.confirmMatches}
    busy={busy} onCancel={cancel} onConfirm={confirm}>
    {error && <p role="alert" className="mb-3 text-red-300">{error}</p>}
    {changed && <p role="status" className="mb-3 text-amber-200">{text.updatedPreview}</p>}
    {groups.map(({ title, decks }) => decks.length > 0 && <section key={title} className="mb-3">
      <h4 className="font-semibold">{title}（{decks.length}）</h4>
      <ul className="mt-1 space-y-2 text-sm">{decks.map((deck) => {
        const shortage = deck.mainShortfall > 0 ? text.missing(text.zones.main, deck.mainShortfall) : '';
        const reasons = [...new Set(deck.issues.map(issueLabel))].filter(label => label !== shortage);
        return <li key={deck.playerId}>
          <strong>{deck.displayName || deck.playerId}</strong>{deck.displayName && deck.displayName !== deck.playerId && ` (${deck.playerId})`}
          {shortage && <span className="ml-2 text-amber-200">{shortage}</span>}
          {reasons.length > 0 && <p>{reasons.join('；')}</p>}
          <p className="text-slate-400">{text.changes(deck.movedToSide, deck.returnedToPool)}</p>
        </li>;
      })}</ul>
    </section>)}
  </ConfirmModal>;
}
