'use client';

import { useCallback, useId, useRef, useState } from 'react';
import type { CardInfo, GuessCardPage, GuessPoolCardVoteRequest, GuessPoolCardVotes, GuessPoolProposalRequest, GuessPoolProposals, GuessPoolVote } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { GuessCards } from './GuessCards';
import { GuessProposalRanking } from './GuessProposalRanking';
import { guessError, guessRequest, useGuessPolling } from './guess-client';
import { fillText, GuessLanguage, GuessText } from './guess-text';

export function GuessPoolCardVote({ poolId, card, text, onChanged }: {
  poolId: number; card: GuessCardPage['cards'][number]; text: GuessText; onChanged?: () => void;
}) {
  const [submitted, setSubmitted] = useState<GuessPoolCardVotes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = submitted ?? card.votes;

  async function vote(choice: GuessPoolVote) {
    if (busy || !value) return;
    setBusy(true);
    setError(null);
    try {
      const body: GuessPoolCardVoteRequest = { vote: value.mine === choice ? null : choice };
      setSubmitted(await guessRequest<GuessPoolCardVotes>(`/pools/${poolId}/cards/${card.code}/vote`, { body }));
      onChanged?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return <div className="guess-card-voting">
    <div className="guess-card-votes" role="group" aria-label={fillText(text.voteForCard, { card: card.name })}>
      {(['like', 'dislike'] as const).map((choice) => <button key={choice} type="button"
        className={`guess-vote-button guess-vote-${choice}`} aria-pressed={value?.mine === choice}
        aria-label={fillText(choice === 'like' ? text.likeCard : text.dislikeCard, { card: card.name })}
        title={value?.mine === choice ? text.cancelCardVote : text.cardVoteHelp}
        disabled={busy || !value} onClick={() => void vote(choice)}>
        <span aria-hidden="true">{choice === 'like' ? '❤' : '👎'}</span>
        <span>{value ? (choice === 'like' ? value.likes : value.dislikes).toLocaleString() : '—'}</span>
      </button>)}
    </div>
    {error != null && <p className="guess-vote-error" role="alert">{guessError(error, text)}</p>}
  </div>;
}

export function GuessPoolProposalsPanel({ poolId, text, language }: {
  poolId: number; text: GuessText; language: GuessLanguage;
}) {
  const path = `/pools/${poolId}/proposals`;
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [state, setState] = useState<GuessPoolProposals | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [voteError, setVoteError] = useState<unknown>(null);
  const [selected, setSelected] = useState<ReadonlyMap<number, CardInfo>>(new Map());
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rankingOpen, setRankingOpen] = useState(false);
  const [voteRevision, setVoteRevision] = useState(0);
  const readVersion = useRef(0);
  const updateState = useCallback((value: GuessPoolProposals) => {
    // A read started before a vote must not replace the newer vote response.
    readVersion.current++; setState(value); setError(null);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++readVersion.current;
    try {
      const result = await guessRequest<GuessPoolProposals>(path, { signal });
      if (!signal?.aborted && version === readVersion.current) { setState(result); setError(null); }
    } catch (err) {
      if (!signal?.aborted && version === readVersion.current) setError(err);
    }
  }, [path]);
  useGuessPolling(refresh, 30_000);

  function open() {
    setVoteError(null);
    setOpened(true);
    dialog.current?.showModal();
    void refresh();
  }

  function choose(card: CardInfo) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(card.code)) next.delete(card.code);
      else if (next.size < (state?.remainingVotes ?? 0)) next.set(card.code, card);
      return next;
    });
  }

  async function propose(body: GuessPoolProposalRequest, closePicker = false) {
    if (busy || !state?.canVote) return;
    setBusy(true);
    setVoteError(null);
    try {
      updateState(await guessRequest<GuessPoolProposals>(path, { body }));
      if (closePicker) dialog.current?.close();
    } catch (err) {
      setVoteError(err);
      await refresh();
    } finally {
      setBusy(false);
      setVoteRevision((current) => current + 1);
    }
  }

  return <section className="guess-proposals" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{text.proposalTop}</h2>
    {state && (state.top.length ? <ol className="guess-proposal-top">
      {state.top.map(({ card, votes, voted }, index) => <li key={card.code} data-proposal-code={card.code}>
        <span className="guess-muted tabular-nums">{index + 1}</span>
        <CardWithTooltip code={card.code} card={card} className="w-8 shrink-0" />
        <span className="min-w-0 grow break-words text-sm">{card.name}</span>
        <span className="guess-pill">{fillText(text.proposalVotes, { count: votes.toLocaleString(language) })}</span>
        <button type="button" className="guess-secondary" aria-label={fillText(text.voteProposalCard, { card: card.name })}
          title={voted ? text.proposalAlreadyVoted : state.canVote ? text.proposalHelp : text.proposalUsed}
          disabled={busy || !state.canVote || voted} onClick={() => void propose({ code: card.code })}>
          {voted ? text.proposalVoted : text.voteProposal}
        </button>
      </li>)}
    </ol> : <p className="guess-muted">{text.noProposals}</p>)}
    {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
    {!opened && voteError != null && <p className="guess-error" role="alert">{guessError(voteError, text)}</p>}
    {!state && error == null && <p className="guess-muted" role="status">{text.loading}</p>}
    <div className="guess-inline flex-wrap">
      <button type="button" className="guess-primary" aria-label={text.proposeCard} aria-haspopup="dialog" disabled={!state?.canVote} onClick={open}
        title={state && !state.hasCandidates ? text.noProposalCandidates : state?.remainingVotes === 0 ? text.proposalUsed
          : `${state ? fillText(text.proposalRemaining, { count: state.remainingVotes, limit: state.dailyLimit }) + '\n' : ''}${text.proposalHelp}`}>
        {text.proposeCard}
        {state && <span className="guess-pill ml-2" aria-hidden="true">{state.remainingVotes}/{state.dailyLimit}</span>}
      </button>
      <button type="button" className="guess-secondary" aria-expanded={rankingOpen} aria-controls={`${id}-ranking`}
        title={text.proposalRankingHelp} onClick={() => setRankingOpen((current) => !current)}>
        {rankingOpen ? text.collapseProposalRanking : text.fullProposalRanking}
      </button>
    </div>
    <div id={`${id}-ranking`} role="region" aria-label={text.fullProposalRanking} hidden={!rankingOpen}>
      {rankingOpen && <GuessProposalRanking poolId={poolId} text={text} language={language}
        busy={busy} canVote={state?.canVote === true} voteRevision={voteRevision} onVote={(code) => void propose({ code })} />}
    </div>
    <dialog ref={dialog} className="guess-proposal-dialog" aria-labelledby={`${id}-title`}
      onClose={() => { setOpened(false); setSelected(new Map()); }}>
      <header className="guess-room-head">
        <h2 id={`${id}-title`}>{text.proposeCard}</h2>
        <button type="button" className="guess-secondary" onClick={() => dialog.current?.close()}>{text.close}</button>
      </header>
      {state && <p className="guess-muted mt-2 tabular-nums" role="status">{fillText(text.proposalRemaining, { count: state.remainingVotes, limit: state.dailyLimit })}</p>}
      {opened && <GuessCards text={text} language={language} path={`${path}/cards`} mode="multi-select" searchMode="name" helpOnHover
        selected={new Set(selected.keys())} selectionLimit={state?.remainingVotes ?? 0} enabled={!busy}
        choose={choose} />}
      <div className="guess-proposal-confirm">
        <div className="guess-inline flex-wrap">
          <span className="tabular-nums" role="status">{fillText(text.proposalsSelected, { count: selected.size })}</span>
          <button type="button" className="guess-primary" title={text.proposalHelp}
            disabled={busy || !state?.canVote || selected.size === 0 || selected.size > state.remainingVotes}
            onClick={() => void propose({ codes: [...selected.keys()] }, true)}>
            {fillText(text.submitProposals, { count: selected.size })}
          </button>
        </div>
        {selected.size > 0 && <ul className="guess-proposal-selection" aria-label={text.selectedProposals}>
          {[...selected.values()].map((card) => <li key={card.code}>
            <button type="button" className="guess-selected" disabled={busy} title={text.removeProposalSelection}
              aria-label={fillText(text.removeProposalCard, { card: card.name })} onClick={() => choose(card)}>{card.name}</button>
          </li>)}
        </ul>}
      </div>
      {voteError != null && <p className="guess-error" role="alert">{guessError(voteError, text)}</p>}
    </dialog>
  </section>;
}
