import { EDISON_E3_MAX_PLAYERS, EDISON_E3_ROUNDS } from '@ygocube/shared';
import { CardsService, isExtraDeckType, TYPE_TOKEN } from '../cards/cards.service';
import type { PackState } from '../events/events.service';

export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createEdisonPacks(codes: number[], players: number, cards: CardsService, dropPublic: boolean) {
  if (players < 2 || players > EDISON_E3_MAX_PLAYERS) throw new Error('BAD_PAYLOAD');
  const types = new Map(cards.getMany(codes).map((card) => [card.code, card.type]));
  const main: number[] = [];
  const extra: number[] = [];
  for (const code of shuffle(codes)) {
    const type = types.get(code);
    if (type === undefined || (type & TYPE_TOKEN)) {
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: { code, message: `卡池中有无法轮抽的卡号 ${code}` } });
    }
    (isExtraDeckType(type) ? extra : main).push(code);
  }
  const mainNeeded = EDISON_E3_ROUNDS.reduce((sum, round) => sum + round.main, 0) * players;
  const fullExtra = EDISON_E3_ROUNDS[1].extra;
  const extraPerPack = players <= 5 ? fullExtra : Math.min(fullExtra, Math.floor(extra.length / players));
  if (main.length < mainNeeded || extra.length < extraPerPack * players) {
    throw Object.assign(new Error('INSUFFICIENT_PACK_RATIO'), { details: {
      requiredMain: mainNeeded, availableMain: main.length, requiredExtra: extraPerPack * players, availableExtra: extra.length,
      message: `Edison 三轮需要 ${mainNeeded} 张主卡、${extraPerPack * players} 张额外卡，卡池现有 ${main.length} 张主卡、${extra.length} 张额外卡`,
    } });
  }
  const packs: PackState[] = [];
  let mainOffset = 0;
  let extraOffset = 0;
  for (const [roundIndex, rule] of EDISON_E3_ROUNDS.entries()) {
    for (let seat = 0; seat < players; seat++) {
      const extraCount = rule.extra ? extraPerPack : 0;
      const order = shuffle([...main.slice(mainOffset, mainOffset + rule.main), ...extra.slice(extraOffset, extraOffset + extraCount)]);
      packs.push({ index: packs.length, size: order.length, order, draftRound: roundIndex + 1, dropCard: null });
      mainOffset += rule.main;
      extraOffset += extraCount;
    }
  }
  const droppedCards = dropPublic ? shuffle([...main.slice(mainOffset), ...extra.slice(extraOffset)]) : [];
  return { packs, droppedCards };
}

export function requiresEdisonPair(pack: PackState, cardsLeft: number): boolean {
  if (pack.draftRound !== 2) return false;
  const startingMain = EDISON_E3_ROUNDS[1].main;
  const startingExtra = pack.size - startingMain;
  // Each paired hand removes one of each. Only the surplus main cards are single picks.
  return cardsLeft > startingMain - startingExtra;
}
