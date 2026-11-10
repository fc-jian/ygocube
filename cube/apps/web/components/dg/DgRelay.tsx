'use client';

import { useCallback, useState } from 'react';
import type { CardInfo, DgActionRequest, DgRelayChainView, DgRelayView, DgRoomView } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { GuessCards } from '@/components/guess/GuessCards';
import { useGuessPolling } from '@/components/guess/guess-client';
import { fillText, guessText, type GuessLanguage } from '@/components/guess/guess-text';
import { DgPicture, DgSketch } from './DgCanvas';
import { DgAnswer } from './DgTurn';
import { dgError, dgRequest, useDgClock } from './dg-client';
import { dgText } from './dg-text';

interface RelayProps {
  room: DgRoomView;
  receivedAt: number;
  token: string | null;
  language: GuessLanguage;
  busy: boolean;
  run: (command: DgActionRequest) => Promise<boolean>;
}

function DgRelayWork({ room, receivedAt, token, language, busy, run, relay }: RelayProps & {
  relay: Extract<DgRelayView, { kind: 'active' }>;
}) {
  const text = dgText[language];
  const shared = guessText[language];
  const labels = text.relay;
  const { countdown, seconds } = useDgClock(room, receivedAt);
  const [selected, setSelected] = useState<CardInfo | null>(null);
  const { round, step } = relay;
  const opening = step === 1;
  const path = `/rooms/${room.roomId}`;
  const canWork = token !== null && !relay.viewerSubmitted;

  return (
    <>
      <div className="dg-stage dg-relay-stage">
        <div className="min-w-0">
          <strong>{fillText(labels.turn, { round, step, total: room.playerCount })}</strong>
          <p className="guess-muted" role="status">{fillText(labels.progress, { count: relay.submittedCount, total: room.playerCount })}</p>
        </div>
        <span className="dg-clock" role="timer">{countdown}</span>
      </div>
      {canWork ? <div className="dg-grid dg-relay-work">
        <div className="dg-stack">
          {opening ? <section className="guess-panel">
            <h2>{labels.choose}</h2>
            <p className="guess-muted">{labels.chooseHelp}</p>
            <ul className="guess-roster">
              {relay.choices.map((card) => <li key={card.code}>
                <CardWithTooltip code={card.code} card={card} className="w-10 shrink-0 sm:w-12" />
                <strong className="min-w-0 grow">{card.name}</strong>
                <button type="button" className={selected?.code === card.code ? 'guess-selected shrink-0' : 'guess-secondary shrink-0'}
                  aria-pressed={selected?.code === card.code} disabled={busy || seconds === 0}
                  onClick={() => setSelected(card)}>{selected?.code === card.code ? shared.selected : shared.select}</button>
              </li>)}
            </ul>
          </section> : <>
            {relay.hasIncomingDrawing ? <DgPicture path={`${path}/relay/${round}/incoming/${step}`} title={labels.received}
              shared={shared} token={token} /> : <section className="guess-panel"><p>{labels.noIncoming}</p></section>}
            <section className="guess-panel">
              <h2>{labels.guess}</h2>
              <p className="guess-muted">{labels.redrawHelp}</p>
              <GuessCards mode="select" path={`${path}/cards`} request={dgRequest} token={token}
                selected={new Set(selected ? [selected.code] : [])} choose={setSelected} enabled={!busy && seconds > 0}
                text={shared} language={language} />
            </section>
          </>}
        </div>
        <div className="dg-stack">
          {selected && <p className="guess-actions guess-live-guess">{fillText(labels.selection, { card: selected.name })}</p>}
          <DgSketch text={text} disabled={busy || seconds === 0 || !selected} submitLabel={opening ? text.submitDrawing : labels.submit}
            submit={(drawing) => {
              if (selected) void run({ action: 'relay-submit', round, step, code: selected.code, drawing });
            }} />
        </div>
      </div> : <section className="guess-panel"><p role="status">{token ? labels.waiting : labels.watching}</p></section>}
    </>
  );
}

function DgRelayStory({ path, language }: { path: string; language: GuessLanguage }) {
  const text = dgText[language];
  const shared = guessText[language];
  const labels = text.relay;
  const [result, setResult] = useState<DgRelayChainView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await dgRequest<DgRelayChainView>(path, { signal });
      if (!signal.aborted) setResult(data);
    } catch (err) {
      if (!signal.aborted) setError(err);
    }
  }, [path]);
  useGuessPolling(result ? null : load, 1500);

  if (!result) return <p className={error ? 'guess-error' : 'guess-muted'} role="status">
    {error ? dgError(error, text, shared) : shared.loading}
  </p>;
  return (
    <div className="dg-stack">
      <DgAnswer label={labels.original} card={result.answer} />
      <ol className="dg-relay-story">
        {result.steps.map((entry, index) => {
          const step = index + 1;
          const title = fillText(labels.stepBy, { step, player: entry.playerId });
          const details = <>
            {entry.receivedFromStep !== null && <p className="guess-muted">{fillText(labels.source, { step: entry.receivedFromStep })}</p>}
            {step > 1 && <p className={entry.correct ? 'dg-correct' : 'guess-muted'}>{entry.guess
              ? fillText(entry.correct ? text.correctGuess : text.incorrectGuess, { card: entry.guess.name })
              : labels.guessMissing}</p>}
          </>;
          return <li key={step}>
            {entry.hasDrawing ? <DgPicture path={`${path}/drawings/${step}`} title={title} shared={shared}>{details}</DgPicture>
              : <section className="guess-panel"><h2>{title}</h2>{details}<p className="guess-muted">{labels.drawingMissing}</p></section>}
          </li>;
        })}
      </ol>
    </div>
  );
}

function DgRelayReview({ room, language, busy, run, relay }: RelayProps & {
  relay: Extract<DgRelayView, { kind: 'reveal' }>;
}) {
  const text = dgText[language];
  const shared = guessText[language];
  const labels = text.relay;
  const [pinned, setPinned] = useState<number | null>(null);
  const { round, revealedCount } = relay;
  const chain = pinned ?? revealedCount;
  const path = `/rooms/${room.roomId}/relay/${round}/chains/${chain}`;
  const canAdvance = room.phase === 'relay_reveal' && room.viewerId !== null && room.viewerId === room.hostId;
  const scores = [...room.players].sort((a, b) => b.score - a.score);

  return (
    <div className="dg-stack">
      <div className="dg-stage">
        <strong>{fillText(labels.reveal, { round })}{room.phase === 'finished' && ` · ${shared.finished}`}</strong>
        {canAdvance && <div className="flex flex-wrap gap-2">
          {revealedCount < room.playerCount ? <button type="button" className="guess-primary" disabled={busy}
            onClick={() => { setPinned(null); void run({ action: 'relay-reveal', round, chain: revealedCount }); }}>{labels.revealNext}</button>
            : <>
              <button type="button" className="guess-primary" disabled={busy}
                onClick={() => void run({ action: 'relay-next', round })}>{labels.nextRound}</button>
              <button type="button" className="guess-secondary" disabled={busy}
                onClick={() => void run({ action: 'relay-finish', round })}>{labels.finish}</button>
            </>}
        </div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {room.players.slice(0, revealedCount).map(({ playerId }, index) => (
          <button key={playerId} type="button" className={chain === index + 1 ? 'guess-selected' : 'guess-secondary'}
            aria-pressed={chain === index + 1} onClick={() => setPinned(index + 1)}>{fillText(labels.chain, { player: playerId })}</button>
        ))}
      </div>
      <DgRelayStory key={path} path={path} language={language} />
      <section className="guess-panel">
        <h2>{text.standings}</h2>
        <ul className="guess-roster">
          {scores.map(({ playerId, score, relayPoints }) => <li className="dg-score-row" key={playerId}>
            <div className="min-w-0">
              <strong>{playerId}{playerId === room.viewerId && <small className="guess-muted"> · {shared.you}</small>}</strong>
              {relayPoints && <p className="guess-muted">{fillText(labels.breakdown, { ...relayPoints })}</p>}
            </div>
            <span>{fillText(text.points, { points: score })}</span>
          </li>)}
        </ul>
      </section>
    </div>
  );
}

export function DgRelay(props: RelayProps) {
  const { relay } = props.room;
  if (!relay) return null;
  return relay.kind === 'active'
    ? <DgRelayWork key={`${relay.round}/${relay.step}`} {...props} relay={relay} />
    : <DgRelayReview key={relay.round} {...props} relay={relay} />;
}
