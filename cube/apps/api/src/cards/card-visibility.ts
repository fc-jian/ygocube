import { TournamentState } from '../events/events.service';
import type { CardVisibilityStatus } from '@ygocube/shared';

/**
 * Return the exact card codes still present in a pack after the recorded picks.
 * Pack order is deliberately not sorted here: this helper models visibility,
 * not the presentation order used by the web client.
 */
export function remainingCardsForPack(state: TournamentState, packIndex: number): number[] {
  const pack = state.packs.find((candidate) => candidate.index === packIndex);
  if (!pack) return [];
  return remainingPackOrder(pack.order, state.picks.filter((p) => p.packIndex === packIndex));
}

export function remainingPackOrder(order: readonly number[], picks: readonly { card: number }[]): number[] {
  const counts = new Map<number, number>();
  for (const { card } of picks) counts.set(card, (counts.get(card) ?? 0) + 1);
  return order.filter((code) => {
    const count = counts.get(code) ?? 0;
    if (!count) return true;
    counts.set(code, count - 1);
    return false;
  });
}

function removeOne(cards: number[], code: number): void {
  const index = cards.indexOf(code);
  if (index >= 0) cards.splice(index, 1);
}

/**
 * Reconstruct the cards a player has actually had an opportunity to see.
 * A player sees the remaining cards immediately before their own pick, not
 * every card that was ever present in the pack. This distinction matters when
 * another player selected a card before the pack reached them.
 */
export function cardsSeenByPlayer(state: TournamentState, playerId: string): Set<number> {
  const seen = new Set<number>();
  const picksByPack = new Map<number, typeof state.picks>();
  for (const pick of state.picks) {
    const picks = picksByPack.get(pick.packIndex) ?? [];
    picks.push(pick);
    picksByPack.set(pick.packIndex, picks);
  }

  for (const pack of state.packs) {
    const remaining = [...pack.order];
    for (const pick of picksByPack.get(pack.index) ?? []) {
      if (pick.playerId === playerId) {
        for (const card of remaining) seen.add(card);
      }
      removeOne(remaining, pick.card);
    }
  }

  // The currently visible pack has not necessarily produced a pick event yet.
  // Add only the passing queue head or the serial cursor pack; queued/future
  // packs remain unknown until they become visible.
  if (state.status === 'drafting') {
    const passing = Object.keys(state.packQueues ?? {}).length > 0;
    const visiblePackIndex = passing
      ? state.packQueues[playerId]?.[0]
      : state.pickCursor?.playerId === playerId
        ? state.pickCursor.packIndex
        : undefined;
    if (visiblePackIndex !== undefined) {
      for (const card of remainingCardsForPack(state, visiblePackIndex)) seen.add(card);
    }
  }
  return seen;
}

/**
 * Classify a card for the deckbuilding search using the authoritative global
 * draft result. Unlike cardsSeenByPlayer this deliberately does not depend on
 * what the requesting player could see during draft.
 */
export function deckbuildingCardClassifier(
  state: TournamentState,
  playerId: string,
  pool: ReadonlySet<number>,
): (code: number) => CardVisibilityStatus {
  const generated = new Set(state.packs.flatMap((pack) => pack.order));
  const own = new Set<number>();
  const others = new Set<number>();
  for (const pick of state.picks) {
    (pick.playerId === playerId ? own : others).add(pick.card);
  }
  return (code) => {
    if (!pool.has(code)) return 'not_in_pool';
    if (!generated.has(code)) return 'dropped';
    if (own.has(code)) return 'picked';
    if (others.has(code)) return 'other_picked';
    return 'unknown';
  };
}
