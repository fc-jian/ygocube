'use client';

import { useState, type ReactNode } from 'react';
import {
  CARD_ATTRIBUTES, CARD_LINK_DIRECTIONS, CARD_RACES, CARD_RANGE_LIMITS, parseCardSubtypeExpression,
  type CardRangeField, type CardSearchFilters, type CardSearchParams,
} from '@ygocube/shared';
import { CardSubtypeEditor } from './CardSubtypeEditor';

const fields = Object.keys(CARD_RANGE_LIMITS) as CardRangeField[];
const masks = ['category', 'subtype', 'attributes', 'races', 'linkMarkers'] as const;
const arrows = [...CARD_LINK_DIRECTIONS.slice(0, 4), null, ...CARD_LINK_DIRECTIONS.slice(4)];
const labels = {
  zh: {
    advanced: '高级筛选', clear: '清除筛选', invalid: '请检查范围。两端应为允许的整数，下限不能超过上限。',
    attributes: '属性', races: '种族', directions: '连接标记', minimum: '下限', maximum: '上限',
    level: '等级／阶级／连接值', atk: '原始攻击力', def: '原始守备力', year: '首发年份', linkCount: '连接标记数',
    help: '区间含两端，留空代表不限。攻守的「?」按 0 筛选。连接怪兽须包含所有选中的箭头。',
  },
  en: {
    advanced: 'Advanced filters', clear: 'Clear filters', invalid: 'Enter valid integers with the minimum at or below the maximum.',
    attributes: 'Attribute', races: 'Monster Type', directions: 'Link arrows', minimum: 'Min', maximum: 'Max',
    level: 'Level / Rank / Link Rating', atk: 'Original ATK', def: 'Original DEF', year: 'First release year', linkCount: 'Link arrow count',
    help: 'Ranges include both endpoints. Leave either end blank for no limit. Unknown ATK and DEF count as 0. A Link Monster must have every selected arrow.',
  },
};

export function cardSearchQuery({ query, page, sort, filters }: CardSearchParams): URLSearchParams {
  const params = new URLSearchParams({ q: query, page: String(page) });
  if (sort !== 'relevance') params.set('sort', sort);
  for (const field of masks) {
    if (filters[field]) params.set(field, String(filters[field]));
  }
  for (const field of fields) {
    const range = filters[field];
    if (range?.min !== undefined) params.set(`${field}Min`, String(range.min));
    if (range?.max !== undefined) params.set(`${field}Max`, String(range.max));
  }
  return params;
}

export function hasCardSearchFilters(filters: CardSearchFilters): boolean {
  return masks.some((field) => !!filters[field])
    || fields.some((field) => filters[field]?.min !== undefined || filters[field]?.max !== undefined);
}

function cardSearchRangesValid(filters: CardSearchFilters): boolean {
  return fields.every((field) => {
    const [lowest, highest] = CARD_RANGE_LIMITS[field];
    const { min, max } = filters[field] ?? {};
    const valid = (value: number | undefined) => value === undefined
      || Number.isInteger(value) && value >= lowest && value <= highest;
    return valid(min) && valid(max) && (min === undefined || max === undefined || min <= max);
  });
}

function subtypeValid(subtype?: string): boolean {
  return !subtype || parseCardSubtypeExpression(subtype) !== null;
}

export function cardSearchFiltersValid(filters: CardSearchFilters): boolean {
  return cardSearchRangesValid(filters) && subtypeValid(filters.subtype);
}

export function CardSearchFields({ value, onChange, onClear, locale = 'zh', children }: {
  value: CardSearchFilters;
  onChange: (value: CardSearchFilters) => void;
  onClear?: () => void;
  locale?: 'zh' | 'en';
  children?: ReactNode;
}) {
  const [editorKey, setEditorKey] = useState(0);
  const text = labels[locale];
  const languageIndex = locale === 'zh' ? 1 : 2;
  const descriptionIndex = locale === 'zh' ? 2 : 3;
  const inputClass = 'w-full min-w-0 rounded border border-slate-500/60 bg-slate-950/40 px-2 py-1 text-sm';
  const filterCount = fields.filter((field) => value[field]?.min !== undefined || value[field]?.max !== undefined).length
    + masks.filter((field) => field !== 'category' && value[field]).length;

  return (
    <details className="rounded-md border border-slate-500/60 px-2.5 py-2 text-sm">
      <summary className="cursor-pointer font-semibold">{text.advanced}{filterCount > 0 && ` (${filterCount})`}</summary>
      <div className="mt-2 grid gap-3">
        <CardSubtypeEditor key={editorKey} locale={locale} expression={value.subtype ?? ''} invalid={!subtypeValid(value.subtype)}
          onChange={(subtype) => onChange({ ...value, subtype: subtype || undefined })} />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
          {fields.map((field) => (
            <fieldset key={field} className="min-w-0">
              <legend>{text[field]}</legend>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {(['min', 'max'] as const).map((bound) => {
                  const endpoint = bound === 'min' ? text.minimum : text.maximum;
                  return <input key={bound} className={inputClass} type="number" step={1}
                    min={CARD_RANGE_LIMITS[field][0]} max={CARD_RANGE_LIMITS[field][1]} inputMode="numeric"
                    aria-label={`${text[field]} ${endpoint}`} placeholder={endpoint} value={value[field]?.[bound] ?? ''}
                    onChange={(event) => onChange({
                      ...value, [field]: {
                        ...value[field], [bound]: event.target.value === '' ? undefined : event.target.valueAsNumber,
                      },
                    })} />;
                })}
              </div>
            </fieldset>
          ))}
        </div>
        {([
          ['attributes', CARD_ATTRIBUTES], ['races', CARD_RACES],
        ] as const).map(([field, options]) => (
          <fieldset key={field}>
            <legend>{text[field]}</legend>
            <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1">
              {options.map((option) => (
                <label key={option[0]} className="inline-flex cursor-pointer items-center gap-1">
                  <input type="checkbox" checked={!!((value[field] ?? 0) & option[0])}
                    onChange={() => onChange({ ...value, [field]: (value[field] ?? 0) ^ option[0] })} />
                  {option[languageIndex]}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend>{text.directions}</legend>
          <div className="mt-1 grid w-fit grid-cols-3 gap-1">
            {arrows.map((option, index) => option ? (
              <button key={option[0]} type="button" className="size-9 rounded border border-slate-500/60 text-base aria-pressed:bg-amber-200 aria-pressed:text-slate-950"
                aria-label={option[descriptionIndex]} aria-pressed={!!((value.linkMarkers ?? 0) & option[0])}
                onClick={() => onChange({ ...value, linkMarkers: (value.linkMarkers ?? 0) ^ option[0] })}>{option[1]}</button>
            ) : <span key={`center-${index}`} className="grid place-items-center text-[.65rem]" aria-hidden="true">LINK</span>)}
          </div>
        </fieldset>
        <p className="text-xs text-slate-300">{text.help}</p>
        {!cardSearchRangesValid(value) && <p className="text-xs text-red-300" role="alert">{text.invalid}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {children}
          <button type="button" className="rounded border border-slate-500/60 px-2 py-1"
            onClick={() => { setEditorKey((key) => key + 1); if (onClear) onClear(); else onChange({}); }}>
            {text.clear}
          </button>
        </div>
      </div>
    </details>
  );
}
