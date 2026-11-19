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
  const remaining = [...pack.order];
  for (const pick of state.picks) {
    if (pick.packIndex !== packIndex) continue;
    const index = remaining.indexOf(pick.card);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
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
export function cardStatusForDeckbuilding(
  state: TournamentState,
  playerId: string,
  poolCodes: Iterable<number>,
  code: number,
): CardVisibilityStatus {
  const pool = new Set(poolCodes);
  if (!pool.has(code)) return 'not_in_pool';

  // A card missing from every generated pack was removed before drafting. This
  // derives private initial drops even when dropPublic=false and no card code
  // was written to the public droppedCards event field.
  const generated = new Set(state.packs.flatMap((pack) => pack.order));
  if (!generated.has(code)) return 'dropped';

  const myPick = state.picks.some((pick) => pick.playerId === playerId && pick.card === code);
  if (myPick) return 'picked';
  if (state.picks.some((pick) => pick.playerId !== playerId && pick.card === code)) return 'other_picked';

  // A normal deckbuilding transition has no remaining unpicked cards. Keep a
  // defensive fallback for an administrator inspecting an incomplete legacy
  // draft rather than mislabelling a card as another player's pick.
  return 'unknown';
}
