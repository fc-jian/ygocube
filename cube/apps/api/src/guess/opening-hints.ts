import { randomInt } from 'node:crypto';
import type { CardInfo, GuessOpeningHint, GuessOpeningHintGroup, GuessOpeningHintMethod, GuessReleaseEra } from '@ygocube/shared';
import { isExtraDeckType } from '../cards/cards.service';
import { FIRST_RELEASE_ERA_CODES } from './first-release-era-codes';

type OpeningCard = Pick<CardInfo, 'code' | 'type' | 'level' | 'attribute' | 'atk' | 'def' | 'setCodes' | 'alias' | 'aliasKind'>;
type CardGroups = Record<GuessOpeningHintMethod, GuessOpeningHintGroup | undefined>;
type HintPools = Partial<Record<GuessOpeningHintGroup, number[]>>;

const MONSTER = 0x1;
const RITUAL = 0x80;
const XYZ = 0x800000;
const PENDULUM = 0x1000000;
const LINK = 0x4000000;
const LIGHT = 0x10;
const DARK = 0x20;
const WIND = 0x8;
const PROPOSALS = 24;
const REFERENCE_POOL_SIZE = 2378;
const releaseEras = new Map<number, GuessReleaseEra>();
for (const [era, codes] of Object.entries(FIRST_RELEASE_ERA_CODES)) {
  for (const code of codes) releaseEras.set(code, era as GuessReleaseEra);
}

function fields(card: OpeningCard): number[] {
  // YGOPro matches the low twelve bits as the base field and the high bits as subfields.
  return [...new Set(card.setCodes.map((code) => code & 0xfff).filter(Boolean))];
}

function groups(card: OpeningCard, largestField: number): CardGroups {
  const releaseEra = releaseEras.get(card.code)
    ?? (card.aliasKind === 'artwork' ? releaseEras.get(card.alias) : undefined);
  const fieldSize = largestField === 0 ? 'no-field' : largestField <= 8 ? 'small-field'
    : largestField <= 13 ? 'medium-field' : 'large-field';
  if (!(card.type & MONSTER)) {
    return {
      deck: 'spell-trap', level: 'spell-trap', attribute: 'spell-trap', attack: 'spell-trap',
      'summon-value': 'spell-trap', defense: 'spell-trap', 'release-era': releaseEra,
      'field-deck': largestField ? 'field-spell-trap' : 'no-field', 'field-size': fieldSize,
      frame: 'spell-trap', 'combat-value': 'spell-trap', 'light-dark': 'spell-trap',
    };
  }

  const extra = isExtraDeckType(card.type);
  const link = Boolean(card.type & LINK);
  const attribute = card.attribute;
  const combatValue = Math.max(card.atk, link ? -1 : card.def);
  return {
    deck: extra ? 'extra-monster' : 'main-monster',
    level: card.type & (XYZ | LINK) ? 'no-level' : card.level <= 4 ? 'low-level' : 'high-level',
    attribute: attribute === DARK ? 'dark' : attribute === LIGHT || attribute === WIND ? 'light-wind' : 'earth-water-fire-divine',
    attack: card.atk <= 1200 ? 'low-attack' : card.atk <= 2300 ? 'medium-attack' : 'high-attack',
    'summon-value': card.level <= 3 ? 'value-1-3' : card.level <= 6 ? 'value-4-6' : 'value-7-plus',
    defense: link || card.def <= 500 ? 'low-defense' : card.def <= 1800 ? 'medium-defense' : 'high-defense',
    'release-era': releaseEra,
    'field-deck': !largestField ? 'no-field' : extra ? 'field-extra-monster' : 'field-main-monster',
    'field-size': fieldSize,
    frame: extra || (card.type & (RITUAL | PENDULUM)) ? 'special-frame' : 'regular-frame',
    'combat-value': combatValue <= 1500 ? 'low-combat-value' : combatValue <= 2400 ? 'medium-combat-value' : 'high-combat-value',
    'light-dark': attribute === LIGHT || attribute === DARK ? 'light-dark' : 'other-attribute',
  };
}

export function buildOpeningHintOptions(cards: readonly OpeningCard[], answers: readonly number[]) {
  const fieldSizes = new Map<number, number>();
  const fieldsByCode = new Map<number, number[]>();
  for (const card of cards) {
    const baseFields = fields(card);
    fieldsByCode.set(card.code, baseFields);
    for (const field of baseFields) fieldSizes.set(field, (fieldSizes.get(field) ?? 0) + 1);
  }

  // Groups shared by several methods have the same membership, such as spell-trap.
  const pools: HintPools = {};
  const dealt = new Map<number, CardGroups>();
  const dealtCodes = new Set(answers);
  for (const card of cards) {
    const largestField = Math.max(0, ...fieldsByCode.get(card.code)!.map((field) => fieldSizes.get(field)!));
    const cardGroups = groups(card, largestField);
    if (dealtCodes.has(card.code)) dealt.set(card.code, cardGroups);
    for (const group of new Set(Object.values(cardGroups))) {
      if (!group) continue;
      (pools[group] ??= []).push(card.code);
    }
  }

  const options = answers.map((answer) => {
    const options: GuessOpeningHint[] = [];
    const cardGroups = dealt.get(answer)!;
    for (const [method, group] of Object.entries(cardGroups) as [GuessOpeningHintMethod, GuessOpeningHintGroup | undefined][]) {
      if (!group) continue;
      const visibleMatches = answers.filter((code) => code !== answer && dealt.get(code)![method] === group).length;
      options.push({ method, group, candidateCount: pools[group]!.length - visibleMatches });
    }
    return options;
  });
  return { options, pools };
}

export function drawOpeningHints(cards: readonly OpeningCard[], answers: readonly number[]): { hints: GuessOpeningHint[]; pools: HintPools } {
  const { options, pools } = buildOpeningHintOptions(cards, answers);
  const tolerance = 150 * cards.length / REFERENCE_POOL_SIZE;
  const halfLife = 40 * cards.length / REFERENCE_POOL_SIZE;
  const proposals = Array.from({ length: PROPOSALS }, () => {
    const hints = options.map((choices) => choices[randomInt(choices.length)]);
    const counts = hints.map((hint) => hint.candidateCount);
    const spread = Math.max(...counts) - Math.min(...counts);
    return { hints, weight: 2 ** (-Math.max(0, spread - tolerance) / halfLife) };
  });
  const randomRange = 2 ** 48 - 1;
  let cursor = randomInt(randomRange) / randomRange * proposals.reduce((total, p) => total + p.weight, 0);
  let chosen = proposals[proposals.length - 1];
  for (const proposal of proposals) {
    cursor -= proposal.weight;
    if (cursor < 0) {
      chosen = proposal;
      break;
    }
  }
  return { hints: chosen.hints, pools: Object.fromEntries(chosen.hints.map(({ group }) => [group, pools[group]!])) };
}
