'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { CardInfo, GuessCardPage } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { guessError, guessRequest } from './guess-client';
import { fillText, GuessText } from './guess-text';

type GuessCardsProps = {
  text: GuessText;
  path: string;
  token?: string;
} & (
  | { mode: 'browse' }
  | { mode: 'add' | 'select'; selected: ReadonlySet<number>; enabled?: boolean; choose: (card: CardInfo) => void }
);

export function GuessCards(props: GuessCardsProps) {
  const { text, path, token, mode } = props;
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState({ query: '', page: 0 });
  const [result, setResult] = useState<GuessCardPage>({ cards: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ q: filter.query, page: String(filter.page) });
    setLoading(true);
    setError(null);
    guessRequest<GuessCardPage>(`${path}?${params}`, { token, signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setResult(next);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, filter, token]);

  function search(event: FormEvent) {
    event.preventDefault();
    setFilter({ query: input.trim(), page: 0 });
  }

  return (
    <div className="guess-card-picker">
      <form className="guess-inline" onSubmit={search}>
        <input className="guess-input" aria-label={text.searchLabel} placeholder={text.searchHint} value={input}
          maxLength={100} onChange={(event) => setInput(event.target.value)} />
        <button className="guess-secondary" type="submit">{text.search}</button>
      </form>
      {loading && <p className="guess-muted" role="status">{text.loading}</p>}
      {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
      {!loading && error == null && result.cards.length === 0 && <p className="guess-muted">{text.searchEmpty}</p>}
      {!loading && error == null && result.cards.length > 0 && (
        <ul className={mode === 'browse' ? 'guess-card-results guess-pool-results' : 'guess-card-results'}>
          {result.cards.map((card) => {
            const active = props.mode !== 'browse' && props.selected.has(card.code);
            return (
              <li key={card.code} data-guess-code={card.code}>
                <CardWithTooltip code={card.code} card={card} className="w-8 shrink-0 sm:w-9" />
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-semibold" title={card.name}>{card.name}</p>
                  <p className="font-mono text-xs text-slate-400">{String(card.code).padStart(8, '0')}</p>
                  {card.stats && (
                    <p className="guess-card-stats guess-muted">
                      <span>{fillText(text.appearances, { count: card.stats.appearances })}</span>
                      <span>{fillText(text.averageTurns, {
                        value: card.stats.averageGuessTurns?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? '—',
                      })}</span>
                    </p>
                  )}
                </div>
                {props.mode !== 'browse' && (
                  <button type="button" className={active ? 'guess-selected' : 'guess-secondary'} disabled={props.enabled === false || active}
                    onClick={() => props.choose(card)}>
                    {mode === 'add' ? active ? text.added : text.add : active ? text.selected : text.select}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(filter.page > 0 || result.hasMore) && (
        <div className="guess-pagination">
          <button type="button" className="guess-secondary" disabled={loading || filter.page === 0}
            onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>{text.prev}</button>
          <span className="guess-muted tabular-nums">{filter.page + 1}</span>
          <button type="button" className="guess-secondary" disabled={loading || error != null || !result.hasMore}
            onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>{text.more}</button>
        </div>
      )}
    </div>
  );
}
