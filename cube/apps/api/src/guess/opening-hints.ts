import { randomInt } from 'node:crypto';
import type { CardInfo, GuessOpeningHint, GuessOpeningHintGroup, GuessOpeningHintMethod } from '@ygocube/shared';
import { baseCardFieldCodes, isExtraDeckType } from '../cards/cards.service';

type OpeningCard = Pick<CardInfo, 'code' | 'type' | 'level' | 'attribute' | 'atk' | 'def' | 'setCodes' | 'releaseYear'>;
type CardGroups = Record<GuessOpeningHintMethod, GuessOpeningHintGroup | undefined>;
type HintPools = Partial<Record<GuessOpeningHintGroup, number[]>>;

export interface OpeningHintHistory {
  lastGroup: GuessOpeningHintGroup;
  counts: ReadonlyMap<GuessOpeningHintGroup, number>;
}

interface WeightedChoice<T> {
  value: T;
  weight: number;
}

const MONSTER = 0x1;
const RITUAL = 0x80;
const XYZ = 0x800000;
const PENDULUM = 0x1000000;
const LINK = 0x4000000;
const LIGHT = 0x10;
const DARK = 0x20;
const WIND = 0x8;
const RANDOM_RANGE = 2 ** 48 - 1;

// Older rounds used the same visible field-size labels with different group IDs.
const LEGACY_FIELD_GROUPS: Partial<Record<GuessOpeningHintGroup, GuessOpeningHintGroup>> = {
  'small-field': 'distinct-field-small',
  'medium-field': 'distinct-field-medium',
  'large-field': 'distinct-field-large',
  'catalog-field-small': 'distinct-field-small',
  'catalog-field-medium': 'distinct-field-medium',
  'catalog-field-large': 'distinct-field-large',
};

export function openingHintHistoryGroup(group: GuessOpeningHintGroup): GuessOpeningHintGroup {
  return LEGACY_FIELD_GROUPS[group] ?? group;
}

function groups(card: OpeningCard, largestField: number | null): CardGroups {
  const year = card.releaseYear;
  const releaseEra = year === undefined ? undefined : year <= 2014 ? 'through-2014'
    : year <= 2019 ? '2015-2019' : year <= 2023 ? '2020-2023' : '2024-plus';
  const fieldSize = largestField === null ? 'no-field' : largestField === 0 ? undefined
    : largestField <= 15 ? 'distinct-field-small' : largestField <= 25 ? 'distinct-field-medium' : 'distinct-field-large';
  if (!(card.type & MONSTER)) {
    return {
      deck: 'spell-trap', level: 'spell-trap', attribute: 'spell-trap', attack: 'spell-trap',
      'summon-value': 'spell-trap', defense: 'spell-trap', 'release-era': releaseEra,
      'field-deck': largestField === null ? 'no-field' : 'field-spell-trap', 'field-size': fieldSize,
      frame: 'spell-trap', 'combat-value': 'spell-trap', 'combat-compare': 'spell-trap', 'light-dark': 'spell-trap',
    };
  }

  const extra = isExtraDeckType(card.type);
  const link = Boolean(card.type & LINK);
  const attribute = card.attribute;
  const combatValue = Math.max(card.atk, link ? -1 : card.def);
  const fixedCombatValues = !link && card.atk >= 0 && card.def >= 0;
  const attackLead = card.atk - card.def;
  return {
    deck: extra ? 'extra-monster' : 'main-monster',
    level: card.type & (XYZ | LINK) ? 'no-level' : card.level <= 4 ? 'low-level' : 'high-level',
    attribute: attribute === DARK ? 'dark' : attribute === LIGHT || attribute === WIND ? 'light-wind' : 'earth-water-fire-divine',
    attack: card.atk <= 1200 ? 'low-attack' : card.atk <= 2300 ? 'medium-attack' : 'high-attack',
    'summon-value': card.level <= 3 ? 'value-1-3' : card.level <= 6 ? 'value-4-6' : 'value-7-plus',
    defense: link || card.def <= 500 ? 'low-defense' : card.def <= 1800 ? 'medium-defense' : 'high-defense',
    'release-era': releaseEra,
    'field-deck': largestField === null ? 'no-field' : extra ? 'field-extra-monster' : 'field-main-monster',
    'field-size': fieldSize,
    frame: extra || (card.type & (RITUAL | PENDULUM)) ? 'special-frame' : 'regular-frame',
    'combat-value': combatValue <= 1500 ? 'low-combat-value' : combatValue <= 2400 ? 'medium-combat-value' : 'high-combat-value',
    'combat-compare': fixedCombatValues && attackLead <= 0 ? 'defense-at-least-attack'
      : fixedCombatValues && attackLead > 500 ? 'attack-over-500' : 'attack-slight-or-unknown',
    'light-dark': attribute === LIGHT || attribute === DARK ? 'light-dark' : 'other-attribute',
  };
}

export function buildOpeningHintOptions(
  cards: readonly OpeningCard[], answers: readonly number[], fieldSizes: ReadonlyMap<number, number>,
) {
  // Groups shared by several methods have the same membership, such as spell-trap.
  const pools: HintPools = {};
  const dealt = new Map<number, CardGroups>();
  const dealtGroupSizes: Partial<Record<GuessOpeningHintGroup, number>> = {};
  const dealtCodes = new Set(answers);
  for (const card of cards) {
    const fields = baseCardFieldCodes(card.setCodes);
    const largestField = fields.length ? Math.max(...fields.map((field) => fieldSizes.get(field) ?? 0)) : null;
    const cardGroups = groups(card, largestField);
    const isDealt = dealtCodes.has(card.code);
    if (isDealt) dealt.set(card.code, cardGroups);
    for (const group of new Set(Object.values(cardGroups))) {
      if (!group) continue;
      (pools[group] ??= []).push(card.code);
      if (isDealt) dealtGroupSizes[group] = (dealtGroupSizes[group] ?? 0) + 1;
    }
  }

  const options = answers.map((answer) => {
    const options: GuessOpeningHint[] = [];
    const cardGroups = dealt.get(answer)!;
    for (const [method, group] of Object.entries(cardGroups) as [GuessOpeningHintMethod, GuessOpeningHintGroup | undefined][]) {
      if (!group) continue;
      const visibleMatches = dealtGroupSizes[group]! - 1;
      options.push({ method, group, candidateCount: pools[group]!.length - visibleMatches });
    }
    return options;
  });
  return { options, pools };
}

function weightedChoice<T>(choices: readonly WeightedChoice<T>[], fraction: number): T {
  let cursor = fraction * choices.reduce((total, choice) => total + choice.weight, 0);
  for (const choice of choices) {
    cursor -= choice.weight;
    if (cursor < 0) return choice.value;
  }
  return choices[choices.length - 1].value;
}

function drawHint(choices: readonly GuessOpeningHint[], history: OpeningHintHistory | undefined, percentile: number) {
  const byGroup = new Map<GuessOpeningHintGroup, GuessOpeningHint[]>();
  for (const hint of choices) {
    if (hint.group === history?.lastGroup) continue;
    const methods = byGroup.get(hint.group);
    if (methods) methods.push(hint);
    else byGroup.set(hint.group, [hint]);
  }

  const bySize = new Map<number, WeightedChoice<GuessOpeningHint[]>[]>();
  for (const [group, methods] of byGroup) {
    const size = methods[0].candidateCount;
    const choice = { value: methods, weight: 1 / (1 + (history?.counts.get(group) ?? 0)) };
    const sizeChoices = bySize.get(size);
    if (sizeChoices) sizeChoices.push(choice);
    else bySize.set(size, [choice]);
  }

  const sizes = [...bySize.entries()].sort(([a], [b]) => a - b).map(([, choices]) => ({
    value: choices,
    weight: choices.reduce((total, choice) => total + choice.weight, 0),
  }));
  const sizeChoices = weightedChoice(sizes, percentile);
  const methods = weightedChoice(sizeChoices, randomInt(RANDOM_RANGE) / RANDOM_RANGE);
  return methods[randomInt(methods.length)];
}

export function drawOpeningHints(
  cards: readonly OpeningCard[], answers: readonly number[], fieldSizes: ReadonlyMap<number, number>,
  histories: readonly (OpeningHintHistory | undefined)[] = [],
): { hints: GuessOpeningHint[]; pools: HintPools } {
  const { options, pools } = buildOpeningHintOptions(cards, answers, fieldSizes);
  // Share the rank within each player's candidate sizes, while drawing independently within a size.
  const percentile = randomInt(RANDOM_RANGE) / RANDOM_RANGE;
  const hints = options.map((choices, i) => drawHint(choices, histories[i], percentile));
  return { hints, pools: Object.fromEntries(hints.map(({ group }) => [group, pools[group]!])) };
}
