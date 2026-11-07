'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { GuessActionRequest, GuessPublicRoomView, GuessRoomView, GuessSession, GuessSpectatorView } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { closeCardPreview } from '@/components/CardPreview';
import { ConfirmModal } from '@/components/ConfirmModal';
import { ApiError } from '@/lib/api';
import { GuessCards } from './GuessCards';
import { GuessFrame, useGuessLanguage } from './GuessFrame';
import { GUESS_PATH, guessError, guessRequest, sessionKey, useGuessPolling } from './guess-client';
import { fillText, GuessText } from './guess-text';

function GuessTable({ room, text }: { room: GuessPublicRoomView | GuessRoomView; text: GuessText }) {
  const viewer = 'viewerId' in room ? room : null;
  const yourTurn = room.currentPlayerId === viewer?.viewerId;
  const turn = room.currentPlayerId
    ? yourTurn ? text.yourTurn : fillText(text.theirTurn, { player: room.currentPlayerId })
    : room.phase === 'finished' ? text.finished : text.roundOver;
  const last = room.lastMove;
  return (
    <div className="guess-table">
      <div className="guess-table-center">
        <p className="guess-kicker">{fillText(text.round, { current: room.round })}</p>
        <p className="guess-turn" aria-live="polite">{turn}</p>
        {last && <div className="guess-muted" aria-live="polite">
          <p>{last.skippedBy
            ? fillText(text.skippedByHost, { player: last.playerId, host: last.skippedBy })
            : fillText(text[last.outcome], { player: last.playerId, points: last.points ?? 0 })}</p>
          {last.card && <p className="truncate" title={last.card.name}>{last.card.name}</p>}
        </div>}
      </div>
      <ul className="guess-seats">
        {room.players.map((player, index) => {
          const angle = Math.PI * (2 * index / room.players.length - 0.5);
          const current = player.playerId === room.currentPlayerId;
          const self = player.playerId === viewer?.viewerId;
          const kind = self && viewer?.viewerCardKind ? text.cardKinds[viewer.viewerCardKind] : null;
          return (
            <li key={player.playerId} className="guess-seat" data-guess-player={player.playerId}
              aria-current={current ? 'true' : undefined}
              style={{ left: `${50 + 37 * Math.cos(angle)}%`, top: `${50 + 36 * Math.sin(angle)}%` }}>
              {player.card ? (
                <CardWithTooltip code={player.card.code} card={player.card} className="guess-seat-card" />
              ) : (
                <div className="guess-seat-card guess-card-back" role="img" aria-label={kind ? `${text.unknown} · ${kind}` : text.unknown}>
                  <span aria-hidden="true">?</span>
                  {kind && <span className="guess-card-kind" aria-hidden="true">{kind}</span>}
                </div>
              )}
              <span className="guess-seat-name" title={player.playerId}>{player.playerId}</span>
              <span className="guess-seat-badge">
                {self && text.you}{self && player.roundPoints !== null && ' · '}
                {player.roundPoints !== null && `+${player.roundPoints}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GuessScores({ room, text, viewerId }: { room: GuessPublicRoomView; text: GuessText; viewerId?: string }) {
  const ranked = [...room.standings].sort((a, b) => b.score - a.score);
  let rank = 0;
  return (
    <section className="guess-panel guess-score-panel">
      <h2>{room.phase === 'finished' ? text.finalStandings : text.standings}</h2>
      <table className="guess-scores">
        <thead><tr><th scope="col">{text.playerId}</th><th scope="col">{text.roundPoints}</th><th scope="col">{text.totalScore}</th></tr></thead>
        <tbody>
          {ranked.map((player, index) => {
            if (index === 0 || player.score !== ranked[index - 1].score) rank = index + 1;
            return <tr key={player.playerId}>
              <th scope="row">
                <span className="guess-rank">{rank}</span>
                {player.playerId}{player.playerId === viewerId && <small className="guess-muted"> · {text.you}</small>}
                {player.departed && <small className="guess-muted"> · {text.departed}</small>}
              </th>
              <td>{player.roundPoints ?? '—'}</td>
              <td><strong>{player.score}</strong></td>
            </tr>;
          })}
        </tbody>
      </table>
    </section>
  );
}

function SpectatorGame({ room, text }: { room: GuessSpectatorView; text: GuessText }) {
  return (
    <div className="guess-game">
      {room.round > 0 && <GuessTable room={room} text={text} />}
      <section className="guess-panel guess-play">
        <h2>{text.spectate}</h2>
        {room.finishReason && <p className="guess-muted">{text.finishReasons[room.finishReason]}</p>}
        {room.currentGuess && room.currentPlayerId && <p className="guess-live-guess" role="status">
          {fillText(text.liveGuess, { player: room.currentPlayerId, card: room.currentGuess.name })}
        </p>}
        {room.round > 0 && <details className="guess-history" open>
          <summary>{text.submittedGuesses}</summary>
          {room.guesses.length === 0 ? <p className="guess-muted">{text.noSubmittedGuesses}</p> : (
            <ul>{room.guesses.map(({ playerId, card, outcome }) => (
              <li key={`${playerId}:${card.code}`}>
                <span>{fillText(outcome === 'correct' ? text.publicGuessCorrect : text.publicGuessIncorrect, { player: playerId, card: card.name })}</span>
              </li>
            ))}</ul>
          )}
        </details>}
      </section>
      <GuessScores room={room} text={text} />
    </div>
  );
}

function GuessHistory({ guesses, text }: { guesses: GuessRoomView['viewerGuesses']; text: GuessText }) {
  return (
    <details className="guess-history" open>
      <summary>{fillText(text.guessedCards, { count: guesses.length })}</summary>
      {guesses.length > 0 && <ul>
        {guesses.map(({ code, name }) => (
          <li key={code}><span>{name}</span><small className="guess-muted font-mono">{String(code).padStart(8, '0')}</small></li>
        ))}
      </ul>}
    </details>
  );
}

export function GuessRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const { text, language, changeLanguage } = useGuessLanguage();
  const roomPath = `/rooms/${roomId}`;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [room, setRoom] = useState<GuessRoomView | null>(null);
  const [watched, setWatched] = useState<GuessSpectatorView | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<'surrender' | 'finish' | null>(null);

  useEffect(() => {
    setRoom(null);
    setWatched(null);
    setToken(localStorage.getItem(sessionKey(roomId)));
  }, [roomId]);
  const refresh = useCallback(async (signal: AbortSignal) => {
    if (!token) return;
    try {
      const state = await guessRequest<GuessRoomView>(roomPath, { token, signal });
      if (!signal.aborted) {
        setRoom((previous) => previous && previous.version > state.version ? previous : state);
        setConnectionError(null);
      }
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        localStorage.removeItem(sessionKey(roomId));
        setToken(null);
        setRoom(null);
        if (err.status === 401) return;
      }
      setConnectionError(err);
    }
  }, [roomId, roomPath, token]);
  const refreshSpectator = useCallback(async (signal: AbortSignal) => {
    try {
      const state = await guessRequest<GuessSpectatorView>(`${roomPath}/spectate`, { signal });
      if (!signal.aborted) {
        setWatched(state);
        setConnectionError(null);
      }
    } catch (err) {
      if (!signal.aborted) setConnectionError(err);
    }
  }, [roomPath]);
  useGuessPolling(token && room?.phase !== 'finished' ? refresh : null, 1500);
  useGuessPolling(token === null && watched?.phase !== 'finished' ? refreshSpectator : null, 1500);

  const round = (room ?? watched)?.round;
  useEffect(() => () => closeCardPreview(), [round]);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setConnectionError(null);
    try {
      const session = await guessRequest<GuessSession>(`${roomPath}/join`, { body: { playerId } });
      localStorage.setItem(sessionKey(roomId), session.token);
      setRoom(session.room);
      setToken(session.token);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function act(body: GuessActionRequest) {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await guessRequest<GuessRoomView | null>(`${roomPath}/action`, { token, body });
      if (body.action === 'leave') {
        localStorage.removeItem(sessionKey(roomId));
        setToken(null);
        setRoom(null);
        router.replace(GUESS_PATH);
      } else if (state) {
        setRoom((previous) => previous && previous.version > state.version ? previous : state);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    setError(null);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${GUESS_PATH}/${roomId}`);
      setCopied(true);
    } catch (err) {
      setError(err);
    }
  }

  const host = room?.hostId === room?.viewerId;
  const playing = room?.phase === 'playing';
  const canGuess = playing && room.currentPlayerId === room.viewerId;
  const selected = canGuess ? room.currentGuess : null;
  const canSurrender = canGuess && room.players.filter((player) => player.roundPoints === null).length === 1;
  const canFinish = host && room?.phase === 'between_rounds';
  const spectator = token === null ? watched : null;
  const canJoin = spectator?.phase === 'lobby' || spectator?.phase === 'between_rounds';
  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head">
        <div className="min-w-0">
          <p className="guess-kicker">{text.roomCode} <span>{roomId}</span></p>
          <h1>{room?.name ?? spectator?.name ?? text.join}</h1>
        </div>
        <button type="button" className="guess-secondary" onClick={() => void copyLink()}>
          {copied ? text.copied : text.copy}
        </button>
      </header>
      {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
      {connectionError != null && <p className="guess-error" role="alert">{guessError(connectionError, text)}</p>}
      {connectionError == null && (token === undefined || (token ? !room : !spectator))
        && <p className="guess-muted" role="status">{text.loading}</p>}
      {canJoin && spectator && (
        <form className="guess-panel guess-fields max-w-md" onSubmit={join}>
          <label>{text.playerId}<input className="guess-input" required maxLength={24} value={playerId}
            onChange={(event) => setPlayerId(event.target.value)} /></label>
          <button className="guess-primary" type="submit" disabled={busy || spectator.playerCount >= spectator.maxPlayers}>{text.join}</button>
        </form>
      )}
      {spectator && spectator.phase !== 'lobby' && <SpectatorGame room={spectator} text={text} />}
      {token && room?.phase === 'lobby' && (
        <section className="guess-panel guess-waiting">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2>{text.waiting}</h2>
            <span className="guess-pill">{room.playerCount}/{room.maxPlayers}</span>
          </div>
          <p className="guess-muted">{text.waitingHelp}</p>
          <p className="guess-muted">{text.pool}{' '}
            <Link className="guess-nav-link underline" href={`${GUESS_PATH}/pools/${room.poolId}`}>
              {room.poolId === 0 ? text.fullPool : room.poolName}
            </Link>
            {' · '}{fillText(text.cardCount, { count: room.poolCount.toLocaleString(language) })}
          </p>
          <ul className="guess-roster">
            {room.players.map((player) => (
              <li key={player.playerId}>
                <strong>{player.playerId}</strong>
                {player.playerId === room.hostId && <span className="guess-pill">{text.host}</span>}
                {player.playerId === room.viewerId && <span className="guess-muted">{text.you}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {host && <button type="button" className="guess-primary" disabled={busy || room.playerCount < 2}
              onClick={() => void act({ action: 'start', version: room.version })}>{text.start}</button>}
            <button type="button" className="guess-secondary" disabled={busy}
              onClick={() => void act({ action: 'leave', version: room.version })}>{text.leave}</button>
          </div>
        </section>
      )}
      {token && room && room.phase !== 'lobby' && (
        <div className="guess-game">
          {room.round > 0 && <GuessTable room={room} text={text} />}
          <section className="guess-panel guess-play">
            {playing && <>
              <h2>{text.pool} <span className="guess-muted">({room.poolCount.toLocaleString(language)})</span></h2>
              {!canGuess && room.currentGuess && room.currentPlayerId && <p className="guess-live-guess" role="status">
                {fillText(text.liveGuess, { player: room.currentPlayerId, card: room.currentGuess.name })}
              </p>}
              {canGuess && <div className="guess-actions">
                <p className={selected ? 'font-semibold' : 'guess-muted'}>{selected?.name ?? text.pickFirst}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="guess-primary" disabled={!selected || busy}
                    onClick={() => selected && void act({ action: 'guess', version: room.version, code: selected.code })}>{text.guess}</button>
                  <button type="button" className="guess-secondary" disabled={busy}
                    onClick={() => void act({ action: 'skip', version: room.version })}>{text.skip}</button>
                  {canSurrender && <button type="button" className="guess-secondary" disabled={busy}
                    onClick={() => setConfirm('surrender')}>{text.surrender}</button>}
                </div>
                <p className="guess-muted">{text.guessHelp}</p>
              </div>}
              {host && !canGuess && <div>
                <button type="button" className="guess-secondary" disabled={busy}
                  onClick={() => void act({ action: 'host-skip', version: room.version })}>{text.hostSkip}</button>
              </div>}
            </>}
            {room.phase === 'between_rounds' && <>
              <h2>{text.roundOver}</h2>
              <div className="flex flex-wrap gap-2">
                {host && <>
                  <button type="button" className="guess-primary" disabled={busy || room.playerCount < 2}
                    onClick={() => void act({ action: 'next', version: room.version })}>{text.next}</button>
                  <button type="button" className="guess-secondary" disabled={busy}
                    onClick={() => setConfirm('finish')}>{text.finish}</button>
                </>}
                <button type="button" className="guess-secondary" disabled={busy}
                  onClick={() => void act({ action: 'leave', version: room.version })}>{text.leave}</button>
              </div>
              {room.playerCount < 2 && <p className="guess-muted">{text.needNextPlayers}</p>}
              {room.playerCount >= 2 && !host && <p className="guess-muted">{text.nextHelp}</p>}
            </>}
            {room.finishReason && <p className="guess-muted">{text.finishReasons[room.finishReason]}</p>}
            {room.round > 0 && <GuessHistory guesses={room.viewerGuesses} text={text} />}
            {playing && <GuessCards key={room.round} text={text} path={`${roomPath}/cards`} token={token} mode="select"
              selected={new Set(selected ? [selected.code] : [])} enabled={canGuess && !busy}
              guessed={new Set(room.viewerGuesses.map(({ code }) => code))}
              choose={(card) => void act({ action: 'select', version: room.version, code: card.code })} />}
          </section>
          <GuessScores room={room} text={text} viewerId={room.viewerId} />
          <ConfirmModal open={confirm === 'surrender' && canSurrender || confirm === 'finish' && canFinish}
            title={confirm === 'finish' ? text.finish : text.surrender}
            confirmText={confirm === 'finish' ? text.confirmFinish : text.confirm}
            cancelText={text.cancel} onCancel={() => setConfirm(null)}
            onConfirm={() => { setConfirm(null); if (confirm) void act({ action: confirm, version: room.version }); }}>
            <p>{confirm === 'finish' ? text.finishHelp : text.surrenderConfirm}</p>
          </ConfirmModal>
        </div>
      )}
    </GuessFrame>
  );
}
