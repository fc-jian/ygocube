'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CARD_SUBTYPES, CARD_SUBTYPE_TAG_LIMIT, type CardSubtype, type CardSubtypeTag } from '@ygocube/shared';

type Locale = 'zh' | 'en';
type Option = { tag: CardSubtypeTag; zh: string; en: string; keywords?: string };

const options: Option[] = [
  { tag: '(', zh: '(', en: '(', keywords: '左括号 left open' },
  { tag: ')', zh: ')', en: ')', keywords: '右括号 right close' },
  { tag: 'and', zh: '与', en: 'AND' },
  { tag: 'or', zh: '或', en: 'OR' },
  ...Object.entries(CARD_SUBTYPES).map(([tag, [, , zh, en]]) => ({ tag: tag as CardSubtype, zh, en })),
];
const optionByTag = new Map(options.map((option) => [option.tag, option]));
const labels = {
  zh: {
    label: '子类型组合', placeholder: '输入标签关键词', none: '没有匹配的标签。',
    help: '例如（融合 或 同调）与 调整。「与」优先于「或」。点击标签可在其后插入。',
    invalid: '组合未完成。请配对括号，并用「与」或「或」连接标签。',
    limit: `最多 ${CARD_SUBTYPE_TAG_LIMIT} 个标签。`,
    insert: (tag: string) => `在 ${tag} 后插入`, remove: (tag: string) => `删除 ${tag}`,
  },
  en: {
    label: 'Subtype expression', placeholder: 'Find a tag', none: 'No matching tags.',
    help: 'For example, (Fusion OR Synchro) AND Tuner. AND takes precedence over OR. Click a tag to insert after it.',
    invalid: 'Complete the expression with matching parentheses and AND or OR between terms.',
    limit: `Up to ${CARD_SUBTYPE_TAG_LIMIT} tags.`,
    insert: (tag: string) => `Insert after ${tag}`, remove: (tag: string) => `Remove ${tag}`,
  },
};

export function CardSubtypeEditor({ expression, onChange, invalid, locale }: {
  expression: string;
  onChange: (expression: string) => void;
  invalid: boolean;
  locale: Locale;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const tags = expression ? expression.split(' ') as CardSubtypeTag[] : [];
  const position = Math.min(cursor ?? tags.length, tags.length);
  const full = tags.length >= CARD_SUBTYPE_TAG_LIMIT;
  const text = labels[locale];
  const query = keyword.normalize('NFKC').trim().toLowerCase();
  const suggestions = options.filter(({ tag, zh, en, keywords }) =>
    [tag, zh, en, keywords ?? ''].some((label) => label.toLowerCase().includes(query)));
  const expanded = open && !full && suggestions.length > 0;
  const active = Math.min(highlighted, suggestions.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;

  function move(position: number) {
    setCursor(position);
    requestAnimationFrame(() => input.current?.focus());
  }

  function insert(tag: CardSubtypeTag) {
    if (full) return;
    onChange([...tags.slice(0, position), tag, ...tags.slice(position)].join(' '));
    setKeyword('');
    setHighlighted(0);
    setOpen(false);
    move(position + 1);
  }

  function remove(index: number) {
    onChange(tags.filter((_, current) => current !== index).join(' '));
    move(position - Number(index < position));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (expanded) insert(suggestions[active].tag);
      else setOpen(true);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = expanded ? (active + step + suggestions.length) % suggestions.length : 0;
      setOpen(true);
      setHighlighted(next);
      requestAnimationFrame(() => document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' }));
    } else if (keyword === '') {
      if (event.key === 'Backspace' && position > 0) {
        event.preventDefault();
        remove(position - 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        move(Math.max(0, Math.min(tags.length, position + step)));
      }
    }
  }

  const controls = tags.map((tag, index) => {
    const label = optionByTag.get(tag)?.[locale] ?? tag;
    return <span key={`${index}-${tag}`} data-card-subtype-tag={tag}
      className="inline-flex max-w-full items-center gap-1 rounded border border-slate-500/60 bg-slate-800 px-1.5 text-xs">
      <button type="button" className="!min-h-0 !p-0" aria-label={text.insert(label)}
        onClick={() => move(index + 1)}>{label}</button>
      <button type="button" className="!min-h-0 !p-0 text-slate-300" aria-label={text.remove(label)}
        onClick={() => remove(index)}>×</button>
    </span>;
  });
  controls.splice(position, 0, (
    <input key="input" id={id} ref={input} className="min-w-[7rem] grow bg-transparent px-1 py-1 text-sm"
      type="text" role="combobox" aria-autocomplete="list" aria-expanded={expanded} autoComplete="off"
      aria-controls={expanded ? `${id}-list` : undefined}
      aria-activedescendant={expanded ? optionId(active) : undefined}
      aria-describedby={`${id}-help${invalid ? ` ${id}-invalid` : ''}`}
      aria-invalid={invalid || undefined}
      placeholder={full ? text.limit : text.placeholder} maxLength={40} value={keyword} disabled={full}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKeyDown}
      onChange={(event) => { setKeyword(event.target.value); setHighlighted(0); setOpen(true); }} />
  ));

  return (
    <div className="grid min-w-0 gap-1" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <label htmlFor={id}>{text.label}</label>
      <div className="relative">
        <div className="flex min-w-0 flex-wrap items-center gap-1 rounded border border-slate-500/60 bg-slate-950/40 px-1.5 py-1">
          {controls}
        </div>
        {expanded && (
          <ul id={`${id}-list`} role="listbox" aria-label={text.label}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-36 overflow-y-auto rounded border border-slate-500/60 bg-slate-900 p-1 shadow-lg">
            {suggestions.map((option, index) => (
              <li key={option.tag} role="presentation">
                <button id={optionId(index)} role="option" type="button" tabIndex={-1} aria-selected={index === active}
                  className="w-full rounded px-2 py-1 text-left text-sm aria-selected:bg-slate-700"
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlighted(index)}
                  onClick={() => insert(option.tag)}>{option[locale]}</button>
              </li>
            ))}
          </ul>
        )}
        {open && !full && suggestions.length === 0 && <p className="absolute inset-x-0 top-full z-20 mt-1 rounded border border-slate-500/60 bg-slate-900 p-2 text-xs text-slate-300"
          role="status">{text.none}</p>}
      </div>
      <p id={`${id}-help`} className="text-xs text-slate-300">{text.help}</p>
      {invalid && <p id={`${id}-invalid`} className="text-xs text-red-300" role="status">{text.invalid}</p>}
    </div>
  );
}
