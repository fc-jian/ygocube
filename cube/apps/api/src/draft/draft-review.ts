import type { DraftReviewHand } from '@ygocube/shared';
import { remainingPackOrder } from '../cards/card-visibility';
import { getDb } from '../db';
import type { PackState } from '../events/events.service';

type ReviewEvent =
  | { action: 'packs_created'; packs: string }
  | { action: 'player_remove'; playerId: string }
  | { action: 'pick'; playerId: string; packIndex: number; card: number; extra: number | null; auto: number };

export function playerDraftHands(tid: number, playerId: string): DraftReviewHand[] {
  const events = getDb().prepare(`
    SELECT action,
      CASE WHEN action='packs_created' THEN coalesce(json_extract(payload_json,'$.packs'),payload_json) END AS packs,
      CASE WHEN action='player_remove' THEN json_extract(payload_json,'$') ELSE json_extract(payload_json,'$.playerId') END AS playerId,
      json_extract(payload_json,'$.packIndex') AS packIndex, json_extract(payload_json,'$.card') AS card,
      json_extract(payload_json,'$.extraCard') AS extra, json_extract(payload_json,'$.auto') AS auto
    FROM events WHERE tournament_id=? AND action IN ('packs_created','pick','player_remove') ORDER BY seq
  `).iterate(tid) as Iterable<ReviewEvent>;
  const hands: DraftReviewHand[] = [];
  let packs = new Map<number, PackState>();
  const picks = new Map<number, { playerId: string; card: number }[]>();
  for (const event of events) {
    if (event.action === 'packs_created') {
      packs = new Map((JSON.parse(event.packs) as PackState[]).map((pack) => [pack.index, pack]));
    } else if (event.action === 'player_remove') {
      // Removed picks become available again from this point in the live reducer.
      for (const [index, taken] of picks) picks.set(index, taken.filter((p) => p.playerId !== event.playerId));
      if (event.playerId === playerId) hands.length = 0;
    } else {
      const pack = packs.get(event.packIndex);
      const taken = picks.get(event.packIndex) ?? [];
      const selected = event.extra == null ? [event.card] : [event.card, event.extra];
      if (pack && event.playerId === playerId) {
        hands.push({ packIndex: pack.index, draftRound: pack.draftRound,
          cards: remainingPackOrder(pack.order, taken), selected, auto: !!event.auto });
      }
      for (const card of selected) taken.push({ playerId: event.playerId, card });
      picks.set(event.packIndex, taken);
    }
  }
  return hands;
}
