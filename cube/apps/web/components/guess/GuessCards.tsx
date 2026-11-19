'use client';

import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { DEFAULT_GUESS_POOL_VOTE_SORT } from '@ygocube/shared';
import type { CardInfo, CardSearchFilters, CardSearchParams, GuessCardPage, GuessPoolVoteSort } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { CardSearchFields, cardSearchFiltersValid, cardSearchQuery } from '@/components/CardSearchFields';
import { guessError, guessRequest } from './guess-client';
import { fillText, GuessLanguage, GuessText } from './guess-text';

type CardSelection = { selected: ReadonlySet<number>; enabled?: boolean; choose: (card: CardInfo) => void };

type GuessCardsProps = {
  text: GuessText;
  language: GuessLanguage;
  path: string;
  token?: string;
  request?: typeof guessRequest;
  searchMode?: 'full' | 'name';
  helpOnHover?: boolean;
  voteSorting?: boolean;
  renderCardActions?: (card: GuessCardPage['cards'][number], refresh: () => void) => ReactNode;
} & (
  | { mode: 'browse' }
  | ({ mode: 'add' } & CardSelection)
  | ({ mode: 'select'; wrongGuesses?: ReadonlySet<number> } & CardSelection)
  | ({ mode: 'multi-select'; selectionLimit: number } & CardSelection)
);

type CardResponse = {
  path: string;
  token?: string;
  filter: CardSearchParams;
  voteSort: GuessPoolVoteSort;
  data?: GuessCardPage;
  error?: unknown;
};

export function GuessCards(props: GuessCardsProps) {
  const { text, language, path, token, mode, searchMode = 'full', request = guessRequest } = props;
  const nameOnly = searchMode === 'name';
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<CardSearchFilters>({});
  const canSearch = cardSearchFiltersValid(draft);
  const [filter, setFilter] = useState<CardSearchParams>({ query: '', page: 0, sort: 'relevance', filters: {} });
  const [voteSort, setVoteSort] = useState<GuessPoolVoteSort>(DEFAULT_GUESS_POOL_VOTE_SORT);
  const [response, setResponse] = useState<CardResponse | null>(null);
  const current = response?.filter === filter && response.voteSort === voteSort && response.path === path && response.token === token ? response : null;
  const waitingForName = nameOnly && mode !== 'browse' && !filter.query;
  const nameSearchHint = mode === 'browse' ? text.poolNameSearchHint : text.nameSearchHint;
  const loading = !waitingForName && current === null;
  const matches = current?.data;
  const error = current?.error;

  useEffect(() => {
    if (waitingForName) return;
    const controller = new AbortController();
    const params = cardSearchQuery(filter);
    if (props.voteSorting) params.set('voteSort', voteSort);
    request<GuessCardPage>(`${path}?${params}`, { token, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResponse({ path, token, filter, voteSort, data });
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setResponse({ path, token, filter, voteSort, error: err });
    });
    return () => controller.abort();
  }, [path, filter, token, request, waitingForName, voteSort, props.voteSorting]);

  function search(event: FormEvent) {
    event.preventDefault();
    if (canSearch) setFilter({ query: input.trim(), page: 0, sort: 'relevance', filters: nameOnly ? {} : draft });
  }

  return (
    <div className="guess-card-picker">
      <form className="grid gap-2" onSubmit={search}>
        <div className="guess-inline">
          <input className="guess-input" aria-label={nameOnly ? text.nameSearchLabel : text.searchLabel}
            placeholder={props.helpOnHover ? nameOnly ? text.nameSearchLabel : text.searchLabel : nameOnly ? nameSearchHint : text.searchHint} value={input}
            maxLength={100} onChange={(event) => setInput(event.target.value)} />
          <button className="guess-secondary" type="submit" title={props.helpOnHover ? nameOnly ? nameSearchHint : text.searchHint : undefined}
            disabled={!canSearch}>{text.search}</button>
        </div>
        {props.voteSorting && <label className="guess-inline text-sm"><span className="shrink-0 whitespace-nowrap">{text.poolSort}</span>
          <select className="guess-input" aria-label={text.poolSort} value={voteSort} onChange={(event) => {
            setVoteSort(event.target.value as GuessPoolVoteSort); setFilter({ ...filter, page: 0 });
          }}>
            <option value={DEFAULT_GUESS_POOL_VOTE_SORT}>{text.netDislikesMost}</option>
            <option value="likes-desc">{text.likesMost}</option><option value="likes-asc">{text.likesLeast}</option>
            <option value="dislikes-desc">{text.dislikesMost}</option><option value="dislikes-asc">{text.dislikesLeast}</option>
            <option value="relevance">{text.searchOrder}</option>
          </select>
        </label>}
        {!nameOnly && <CardSearchFields value={draft} onChange={setDraft} locale={language}
          onClear={() => { setDraft({}); setFilter({ ...filter, page: 0, filters: {} }); }}>
          <button type="submit" className="guess-secondary" disabled={!canSearch}>{text.applyFilters}</button>
        </CardSearchFields>}
      </form>
      {waitingForName && !props.helpOnHover && <p className="guess-muted">{nameSearchHint}</p>}
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
            const wrong = props.mode === 'select' && props.wrongGuesses?.has(card.code);
            const proposed = (props.mode === 'select' || props.mode === 'multi-select') && card.proposedByViewer;
            const atLimit = props.mode === 'multi-select' && !active && props.selected.size >= props.selectionLimit;
            return (
              <li key={card.code} data-guess-code={card.code}>
                <CardWithTooltip code={card.code} card={card} className="w-8 shrink-0 sm:w-9" />
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-semibold" title={card.name}>{card.name}</p>
                  <p className="font-mono text-xs text-slate-400">
                    {String(card.code).padStart(8, '0')}
                    {wrong && (
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
                {props.renderCardActions?.(card, () => setFilter((current) => ({ ...current })))}
                {props.mode !== 'browse' && (
                  <button type="button" className={active ? 'guess-selected' : 'guess-secondary'}
                    disabled={props.enabled === false || (active && mode !== 'multi-select') || wrong || proposed || atLimit}
                    aria-pressed={mode === 'multi-select' ? active : undefined}
                    title={proposed ? text.proposalAlreadyVoted : undefined}
                    onClick={() => props.choose(card)}>
                    {proposed ? text.proposalVoted : mode === 'add' ? active ? text.added : text.add : active ? text.selected : text.select}
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
