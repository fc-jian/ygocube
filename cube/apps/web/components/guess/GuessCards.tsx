'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { CardInfo, GuessCardPage } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { guessError, guessRequest } from './guess-client';
import { fillText, GuessText } from './guess-text';

type CardSelection = { selected: ReadonlySet<number>; enabled?: boolean; choose: (card: CardInfo) => void };

type GuessCardsProps = {
  text: GuessText;
  path: string;
  token?: string;
} & (
  | { mode: 'browse' }
  | ({ mode: 'add' } & CardSelection)
  | ({ mode: 'select'; guessed: ReadonlySet<number> } & CardSelection)
);

type CardFilter = { query: string; page: number };
type CardResponse = {
  path: string;
  token?: string;
  filter: CardFilter;
  data?: GuessCardPage;
  error?: unknown;
};

export function GuessCards(props: GuessCardsProps) {
  const { text, path, token, mode } = props;
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<CardFilter>({ query: '', page: 0 });
  const [response, setResponse] = useState<CardResponse | null>(null);
  const current = response?.filter === filter && response.path === path && response.token === token ? response : null;
  const loading = current === null;
  const matches = current?.data;
  const error = current?.error;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ q: filter.query, page: String(filter.page) });
    guessRequest<GuessCardPage>(`${path}?${params}`, { token, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResponse({ path, token, filter, data });
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setResponse({ path, token, filter, error: err });
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
      {matches && <p className="guess-muted tabular-nums" role="status">
        {fillText(filter.page < matches.totalPages ? text.searchPage : text.searchTotals, {
          count: matches.totalCount.toLocaleString(), page: filter.page + 1, pages: matches.totalPages.toLocaleString(),
        })}
      </p>}
      {matches?.cards.length === 0 && <p className="guess-muted">{text.searchEmpty}</p>}
      {matches && matches.cards.length > 0 && (
        <ul className={mode === 'browse' ? 'guess-card-results guess-pool-results' : 'guess-card-results'}>
          {matches.cards.map((card) => {
            const active = props.mode !== 'browse' && props.selected.has(card.code);
            return (
              <li key={card.code} data-guess-code={card.code}>
                <CardWithTooltip code={card.code} card={card} className="w-8 shrink-0 sm:w-9" />
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-semibold" title={card.name}>{card.name}</p>
                  <p className="font-mono text-xs text-slate-400">
                    {String(card.code).padStart(8, '0')}
                    {props.mode === 'select' && props.guessed.has(card.code) && (
                      <span className="ml-2 font-sans text-amber-200">{text.alreadyGuessed}</span>
                    )}
                  </p>
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
      {(filter.page > 0 || matches?.hasMore) && (
        <div className="guess-pagination">
          <button type="button" className="guess-secondary" disabled={loading || filter.page === 0}
            onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>{text.prev}</button>
          <button type="button" className="guess-secondary" disabled={!matches?.hasMore}
            onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>{text.more}</button>
        </div>
      )}
    </div>
  );
}
