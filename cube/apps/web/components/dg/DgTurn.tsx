'use client';

import { useState } from 'react';
import { DG_GUESS_COOLDOWN_MS, type CardInfo, type DgActionRequest, type DgRoomView, type DgTurnView } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { GuessCards } from '@/components/guess/GuessCards';
import { GuessHintButton } from '@/components/guess/GuessHintButton';
import { fillText, guessText, type GuessLanguage } from '@/components/guess/guess-text';
import { DgPicture } from './DgCanvas';
import { DgLivePicture, DgLiveSketch } from './DgLiveCanvas';
import { dgRequest, useDgClock } from './dg-client';
import { dgText } from './dg-text';

type RunAction = (command: DgActionRequest) => Promise<boolean>;

export function DgAnswer({ label, card, description }: { label: string; card: CardInfo; description?: string }) {
  return (
    <section className="guess-panel">
      <div className="dg-card">
        <CardWithTooltip code={card.code} card={card} className="w-12 shrink-0 sm:w-16" />
        <div className="min-w-0">
          <p className="guess-muted">{label}</p>
          <h2>{card.name}</h2>
          {description && <p className="guess-muted">{description}</p>}
        </div>
      </div>
    </section>
  );
}

function DgGuessPanel({ room, turn, token, language, now, busy, run }: {
  room: DgRoomView;
  turn: DgTurnView;
  token: string;
  language: GuessLanguage;
  now: number;
  busy: boolean;
  run: RunAction;
}) {
  const [selected, setSelected] = useState<CardInfo | null>(null);
  const text = dgText[language];
  const shared = guessText[language];
  const last = room.viewerLastGuess;
  const canGuess = !busy && room.deadlineAt !== null && room.deadlineAt > now
    && (last === null || now - last.at >= DG_GUESS_COOLDOWN_MS);

  async function guess() {
    if (selected && await run({ action: 'guess', turn: turn.number, code: selected.code })) setSelected(null);
  }

  return (
    <section className="guess-panel">
      <h2>{text.guessTitle}</h2>
      <p className="guess-muted">{text.guessHelp}</p>
      {last && <p className={last.correct ? 'dg-correct' : 'guess-muted'} role="status">
        {fillText(last.correct ? text.correctGuess : text.incorrectGuess, { card: last.card.name })}
      </p>}
      <div className="guess-actions">
        {selected && <p className="guess-live-guess">{selected.name}</p>}
        <button type="button" className="guess-primary" disabled={!selected || !canGuess}
          onClick={() => void guess()}>{text.submitGuess}</button>
      </div>
      <GuessCards mode="select" path={`/rooms/${room.roomId}/cards`} request={dgRequest} token={token}
        selected={new Set(selected ? [selected.code] : [])} choose={setSelected} enabled={!busy}
        text={shared} language={language} />
    </section>
  );
}

export function DgTurn({ room, turn, receivedAt, token, language, busy, run }: {
  room: DgRoomView;
  turn: DgTurnView;
  receivedAt: number;
  token: string | null;
  language: GuessLanguage;
  busy: boolean;
  run: RunAction;
}) {
  const text = dgText[language];
  const shared = guessText[language];
  const running = room.deadlineAt !== null;
  const { now, seconds, countdown } = useDgClock(room, receivedAt);
  const drawing = room.phase === 'drawing';
  const guessing = room.phase === 'guessing';
  const canGuess = drawing || guessing;
  const revealed = room.phase === 'reveal' || room.phase === 'finished';
  const isHost = room.viewerId !== null && room.viewerId === room.hostId;
  const isDrawer = room.viewerId === turn.drawerId;
  const solved = turn.solves.some((entry) => entry.playerId === room.viewerId);
  const hintPending = turn.hintAt !== null && room.serverNow < turn.hintAt;
  const scores = [...room.players].sort((a, b) => b.score - a.score);
  const path = `/rooms/${room.roomId}/drawing/${turn.number}`;
  const stage = drawing ? text.drawAndGuess : guessing ? text.guessTitle : room.phase === 'reveal' ? shared.roundOver : shared.finished;

  return (
    <>
      <div className="dg-stage">
        <div className="min-w-0">
          <strong>{fillText(text.turn, { turn: turn.number })} · {stage}</strong>
          <p className="guess-muted break-words">{fillText(text.drawer, { player: turn.drawerId })}</p>
        </div>
        {running && <span className="dg-clock" role="timer" title={stage}>{countdown}</span>}
        {room.phase === 'reveal' && (isHost ? <div className="flex flex-wrap gap-2">
          <button type="button" className="guess-primary" disabled={busy}
            onClick={() => void run({ action: 'next', turn: turn.number })}>{text.nextRound}</button>
          <button type="button" className="guess-secondary" disabled={busy}
            onClick={() => void run({ action: 'finish', turn: turn.number })}>{text.finish}</button>
        </div> : <p className="guess-muted" role="status">{text.waitForNextRound}</p>)}
      </div>
      <div className="dg-grid">
        <div className="dg-stack">
          {turn.answer && <DgAnswer card={turn.answer} label={revealed ? text.answer : text.yourCard}
            description={drawing && isDrawer ? text.drawHelp : undefined} />}
          {drawing && (isDrawer && token
            ? <DgLiveSketch key={turn.number} path={path} token={token} text={text} disabled={seconds === 0} />
            : <DgLivePicture key={turn.number} path={path} text={text} />)}
          {turn.hasDrawing && <DgPicture key={turn.number} path={path} title={text.submittedDrawing} shared={shared} />}
          {revealed && !turn.hasDrawing && <section className="guess-panel"><p>{text.drawTimedOut}</p></section>}
        </div>
        <div className="dg-stack">
          {canGuess && !isDrawer && room.settings.hintsEnabled && (
            <section className="guess-panel" aria-label={text.hint}>
              {turn.hint ? <div className="flex flex-wrap items-center gap-2">
                <h2>{text.hint}</h2>
                <GuessHintButton hint={turn.hint} text={shared} />
                <span className="guess-muted">{fillText(shared.hintCandidates, { count: turn.hint.candidateCount })}</span>
              </div> : <p className="guess-muted" role="status">{hintPending ? text.hintPending : text.noHint}</p>}
            </section>
          )}
          {canGuess && (token && !isDrawer && !solved
            ? <DgGuessPanel key={turn.number} room={room} turn={turn} token={token} language={language} now={now} busy={busy} run={run} />
            : !isDrawer && <section className="guess-panel"><p role="status">{solved ? text.guessedAlready : text.watchingGuess}</p></section>)}
          <section className="guess-panel">
            <h2>{text.solveOrder}</h2>
            {turn.solves.length === 0 && <p className="guess-muted">{revealed ? text.noFinalSolves : text.noSolves}</p>}
            <ol className="guess-roster">
              {turn.solves.map(({ playerId, points }, index) => <li className="dg-score-row" key={playerId}>
                <strong>{index + 1}. {playerId}</strong><span>+{points}</span>
              </li>)}
            </ol>
            <p className="guess-muted">{fillText(text.drawerScore, { points: turn.drawerPoints })}</p>
          </section>
          <section className="guess-panel">
            <h2>{text.standings}</h2>
            <ul className="guess-roster">
              {scores.map(({ playerId, score }) => <li className="dg-score-row" key={playerId}>
                <strong>{playerId}{playerId === room.viewerId && <small className="guess-muted"> · {shared.you}</small>}</strong>
                <span>{fillText(text.points, { points: score })}</span>
              </li>)}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
