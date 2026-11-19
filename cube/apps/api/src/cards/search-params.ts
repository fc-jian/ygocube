import { BadRequestException } from '@nestjs/common';
import {
  CARD_ATTRIBUTES, CARD_LINK_DIRECTIONS, CARD_RACES, CARD_RANGE_LIMITS, parseCardSubtypeExpression,
  type CardCategory, type CardRangeField, type CardSearchFilters, type CardSearchParams,
} from '@ygocube/shared';

function badPayload(): never {
  throw new BadRequestException({ code: 'BAD_PAYLOAD' });
}

function integer(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) badPayload();
  const number = Number(value);
  if (number < min || number > max) badPayload();
  return number;
}

function mask(value: unknown, allowed: number): number | undefined {
  const bits = integer(value, 0, allowed);
  if (bits !== undefined && (bits & ~allowed) !== 0) badPayload();
  return bits || undefined;
}

const attributeMask = CARD_ATTRIBUTES.reduce((bits, [value]) => bits | value, 0);
const raceMask = CARD_RACES.reduce((bits, [value]) => bits | value, 0);
const linkMask = CARD_LINK_DIRECTIONS.reduce((bits, [value]) => bits | value, 0);

export function parseCardSearchParams(query: Record<string, unknown>): CardSearchParams {
  const { q = '', sort = 'relevance', subtype } = query;
  if (typeof q !== 'string' || q.length > 100) badPayload();
  if (sort !== 'relevance' && sort !== 'level' && sort !== 'attack' && sort !== 'name') badPayload();
  if (subtype !== undefined && (typeof subtype !== 'string' || !parseCardSubtypeExpression(subtype))) badPayload();
  const category = integer(query.category, 1, 4);
  if (category !== undefined && category !== 1 && category !== 2 && category !== 4) badPayload();
  const filters: CardSearchFilters = {
    category: category as CardCategory | undefined,
    subtype,
    attributes: mask(query.attributes, attributeMask),
    races: mask(query.races, raceMask),
    linkMarkers: mask(query.linkMarkers, linkMask),
  };
  for (const field of Object.keys(CARD_RANGE_LIMITS) as CardRangeField[]) {
    const [lowest, highest] = CARD_RANGE_LIMITS[field];
    const min = integer(query[`${field}Min`], lowest, highest);
    const max = integer(query[`${field}Max`], lowest, highest);
    if (min !== undefined && max !== undefined && min > max) badPayload();
    if (min !== undefined || max !== undefined) filters[field] = { min, max };
  }
  return { query: q.trim(), page: integer(query.page, 0, 99999) ?? 0, filters, sort };
}
