import { Injectable } from '@nestjs/common';
import type {
  SmallWorldCalculationResponse,
  SmallWorldPath,
  SmallWorldSharedProperty,
} from '@ygocube/shared';
import type { CardInfo } from '../cards/cards.service';
import { CardsService } from '../cards/cards.service';

const TYPE_MONSTER = 0x1;
// Fusion, Synchro, Xyz and Link. This is the same mask used by CardsService
// when deciding whether a card belongs to the Extra Deck.
const TYPES_EXTRA_DECK = 0x4802040;

const SMALL_WORLD_PROPERTIES: readonly SmallWorldSharedProperty[] = [
  'race',
  'attribute',
  'level',
  'atk',
  'def',
];

export function isSmallWorldEligible(card: CardInfo): boolean {
  return (card.type & TYPE_MONSTER) !== 0 && (card.type & TYPES_EXTRA_DECK) === 0;
}

/**
 * Return the one property shared by two cards, or null when the pair is not a
 * legal Small World connection. The comparison intentionally uses the exact
 * cards.cdb values, including zero ATK/DEF/Level values.
 */
export function sharedSmallWorldProperty(a: CardInfo, b: CardInfo): SmallWorldSharedProperty | null {
  const shared = SMALL_WORLD_PROPERTIES.filter((property) => a[property] === b[property]);
  return shared.length === 1 ? shared[0] : null;
}

function uniqueCodes(codes: number[]): number[] {
  return [...new Set(codes)];
}

/**
 * Pure path enumeration. The input card list must contain exact metadata rows;
 * unknown/non-eligible input cards are ignored here so this function can be
 * reused independently of NestJS and tested with small fixtures.
 */
export function enumerateSmallWorldPaths(
  cards: CardInfo[],
  deckCodes: number[],
  handCodes: number[],
): SmallWorldPath[] {
  const cardMap = new Map(cards.map((card) => [card.code, card]));
  const deckCounts = new Map<number, number>();
  for (const code of deckCodes) {
    const card = cardMap.get(code);
    if (!card || !isSmallWorldEligible(card)) continue;
    deckCounts.set(code, (deckCounts.get(code) ?? 0) + 1);
  }

  const eligibleDeckCodes = [...deckCounts.keys()];
  const autoHandMode = handCodes.length === 0;
  const eligibleHandCodes = (autoHandMode ? eligibleDeckCodes : uniqueCodes(handCodes)).filter((code) => {
    const card = cardMap.get(code);
    return !!card && isSmallWorldEligible(card);
  });
  const paths: SmallWorldPath[] = [];
  const bridgeTargets = new Map<number, Array<{ targetCode: number; shared: SmallWorldSharedProperty }>>();

  // Build card relationships once.  Automatic deck-wide mode can contain
  // hundreds of candidate hands; reusing this graph avoids repeating the
  // metadata comparison for every candidate.
  for (const bridgeCode of eligibleDeckCodes) {
    const bridge = cardMap.get(bridgeCode);
    if (!bridge) continue;
    const targets: Array<{ targetCode: number; shared: SmallWorldSharedProperty }> = [];
    for (const targetCode of eligibleDeckCodes) {
      const target = cardMap.get(targetCode);
      if (!target) continue;
      const shared = sharedSmallWorldProperty(bridge, target);
      if (shared) targets.push({ targetCode, shared });
    }
    bridgeTargets.set(bridgeCode, targets);
  }

  for (const handCode of eligibleHandCodes) {
    const hand = cardMap.get(handCode);
    if (!hand) continue;

    // In automatic deck-wide mode the first card is also drawn from this
    // physical deck.  Remove exactly one copy before looking for bridge and
    // target cards, so a singleton cannot be reused in two roles.
    const availableCounts = new Map(deckCounts);
    if (autoHandMode) {
      const handCount = availableCounts.get(handCode) ?? 0;
      if (handCount <= 0) continue;
      availableCounts.set(handCode, handCount - 1);
    }
    const availableDeckCodes = eligibleDeckCodes.filter((code) => (availableCounts.get(code) ?? 0) > 0);

    for (const bridgeCode of availableDeckCodes) {
      const bridge = cardMap.get(bridgeCode);
      if (!bridge) continue;
      const handBridgeShared = sharedSmallWorldProperty(hand, bridge);
      if (!handBridgeShared) continue;

      for (const { targetCode, shared: bridgeTargetShared } of bridgeTargets.get(bridgeCode) ?? []) {
        // The bridge is removed before the target is added. The same printed
        // code therefore needs two remaining physical copies.
        if ((availableCounts.get(targetCode) ?? 0) <= 0) continue;
        if (targetCode === bridgeCode && (availableCounts.get(targetCode) ?? 0) < 2) continue;
        paths.push({ handCode, bridgeCode, targetCode, handBridgeShared, bridgeTargetShared });
      }
    }
  }

  return paths;
}

@Injectable()
export class SmallWorldService {
  constructor(private cards: CardsService) {}

  calculate(deckCodes: number[], handCodes: number[] = []): SmallWorldCalculationResponse {
    const autoHandMode = handCodes.length === 0;
    const requestedCodes = uniqueCodes([...deckCodes, ...handCodes]);
    const cardMap = new Map<number, CardInfo>();
    const unknownCodes: number[] = [];

    for (const code of requestedCodes) {
      const card = this.cards.getLiteral(code);
      if (card) cardMap.set(code, card);
      else unknownCodes.push(code);
    }

    const cards = [...cardMap.values()];
    const eligibleDeckCodes = uniqueCodes(deckCodes).filter((code) => {
      const card = cardMap.get(code);
      return !!card && isSmallWorldEligible(card);
    });
    const eligibleHandCodes = (autoHandMode ? eligibleDeckCodes : uniqueCodes(handCodes)).filter((code) => {
      const card = cardMap.get(code);
      return !!card && isSmallWorldEligible(card);
    });
    const paths = enumerateSmallWorldPaths(cards, deckCodes, handCodes);

    return {
      cards,
      paths,
      unknownCodes,
      summary: {
        deckCount: deckCodes.length,
        handCount: autoHandMode ? eligibleHandCodes.length : handCodes.length,
        eligibleDeckCount: eligibleDeckCodes.length,
        eligibleHandCount: eligibleHandCodes.length,
        pathCount: paths.length,
        handMode: autoHandMode ? 'deck_unique' : 'provided',
      },
    };
  }
}
