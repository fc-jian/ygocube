'use client';

import { FormEvent, useCallback, useState } from 'react';
import type { GuessPoolProposalPage } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { guessError, guessRequest, useGuessPolling } from './guess-client';
import { fillText, GuessLanguage, GuessText } from './guess-text';

type Filter = { query: string; page: number };

export function GuessProposalRanking({ poolId, text, language, busy, canVote, voteRevision, onVote }: {
  poolId: number; text: GuessText; language: GuessLanguage; busy: boolean; canVote: boolean;
  voteRevision: number; onVote: (code: number) => void;
}) {
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<Filter>({ query: '', page: 0 });
  const [response, setResponse] = useState<{ filter: Filter; voteRevision: number; data?: GuessPoolProposalPage; error?: unknown } | null>(null);
  const current = response?.filter === filter ? response : null;
  const data = current?.data;
  const fetchRanking = useCallback(async (signal: AbortSignal) => {
    try {
      const params = new URLSearchParams({ q: filter.query, page: String(filter.page) });
      const data = await guessRequest<GuessPoolProposalPage>(`/pools/${poolId}/proposals/ranking?${params}`, { signal });
      if (!signal.aborted) setResponse({ filter, voteRevision, data });
    } catch (error) {
      if (!signal.aborted) setResponse({ filter, voteRevision, error });
    }
  }, [poolId, filter, voteRevision]);
  useGuessPolling(fetchRanking, 30_000);

  function search(event: FormEvent) {
    event.preventDefault();
    setFilter({ query: input.trim(), page: 0 });
  }

  return (
    <>
      <form className="guess-inline" onSubmit={search}>
        <input className="guess-input" aria-label={text.nameSearchLabel} placeholder={text.nameSearchLabel}
          maxLength={100} value={input} onChange={(event) => setInput(event.target.value)} />
        <button type="submit" className="guess-secondary" title={text.proposalRankingHelp}>{text.search}</button>
      </form>
      {!current && <p className="guess-muted mt-3" role="status">{text.loading}</p>}
      {current?.error != null && <p className="guess-error mt-3" role="alert">{guessError(current.error, text)}</p>}
      {data && <>
        <p className="guess-muted mt-3 tabular-nums" role="status">{fillText(data.totalPages > filter.page ? text.searchPage : text.searchTotals, {
          count: data.totalCount.toLocaleString(language), pages: data.totalPages.toLocaleString(language), page: filter.page + 1,
        })}</p>
        {data.proposals.length === 0 && <p className="guess-muted mt-3">{filter.query ? text.searchEmpty : text.noProposals}</p>}
        <ol className="guess-proposal-ranking mt-3">
          {data.proposals.map(({ card, votes, rank, voted }) => <li key={card.code} data-proposal-code={card.code} data-proposal-rank={rank}>
            <span className="guess-muted tabular-nums">{rank}</span>
            <CardWithTooltip code={card.code} card={card} className="w-8 shrink-0" />
            <span className="min-w-0 grow truncate text-sm" title={card.name}>{card.name}</span>
            <span className="guess-pill">{fillText(text.proposalVotes, { count: votes.toLocaleString(language) })}</span>
            <button type="button" className="guess-secondary" aria-label={fillText(text.voteProposalCard, { card: card.name })}
              title={voted ? text.proposalAlreadyVoted : canVote && data.canVote ? text.proposalHelp : text.proposalUsed}
              disabled={busy || !canVote || !data.canVote || voted || current?.voteRevision !== voteRevision}
              onClick={() => onVote(card.code)}>
              {voted ? text.proposalVoted : text.voteProposal}
            </button>
          </li>)}
        </ol>
        {(filter.page > 0 || data.hasMore) && <div className="guess-pagination mt-3">
          <button type="button" className="guess-secondary" disabled={filter.page === 0}
            onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>{text.prev}</button>
          <button type="button" className="guess-secondary" disabled={!data.hasMore}
            onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>{text.more}</button>
        </div>}
      </>}
    </>
  );
}
