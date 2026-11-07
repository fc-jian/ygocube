'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { CardInfo, GuessActionRequest, GuessRoomView, GuessSession } from '@ygocube/shared';
import { CardWithTooltip } from '@/components/CardImage';
import { closeCardPreview } from '@/components/CardPreview';
import { ConfirmModal } from '@/components/ConfirmModal';
import { ApiError } from '@/lib/api';
import { GuessCards } from './GuessCards';
import { GuessFrame, useGuessLanguage } from './GuessFrame';
import { GUESS_PATH, guessError, guessRequest, sessionKey, useGuessPolling } from './guess-client';
import { fillText, GuessText } from './guess-text';

function GuessTable({ room, text }: { room: GuessRoomView; text: GuessText }) {
  const yourTurn = room.currentPlayerId === room.viewerId;
  const turn = room.currentPlayerId
    ? yourTurn ? text.yourTurn : fillText(text.theirTurn, { player: room.currentPlayerId })
    : room.phase === 'finished' ? text.finished : text.roundOver;
  const last = room.lastMove;
  return (
    <div className="guess-table">
      <div className="guess-table-center">
        <p className="guess-kicker">{fillText(text.round, { current: room.round })}</p>
        <p className="guess-turn" aria-live="polite">{turn}</p>
        {last && <p className="guess-muted" aria-live="polite">
          {fillText(text[last.outcome], { player: last.playerId, points: last.points ?? 0 })}
        </p>}
      </div>
      <ul className="guess-seats">
        {room.players.map((player, index) => {
          const angle = Math.PI * (2 * index / room.players.length - 0.5);
          const current = player.playerId === room.currentPlayerId;
          const self = player.playerId === room.viewerId;
          return (
            <li key={player.playerId} className="guess-seat" data-guess-player={player.playerId}
              aria-current={current ? 'true' : undefined}
              style={{ left: `${50 + 37 * Math.cos(angle)}%`, top: `${50 + 36 * Math.sin(angle)}%` }}>
              {player.card ? (
                <CardWithTooltip code={player.card.code} card={player.card} className="guess-seat-card" />
              ) : (
                <div className="guess-seat-card guess-card-back" role="img" aria-label={text.unknown}><span aria-hidden="true">?</span></div>
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

function GuessScores({ room, text }: { room: GuessRoomView; text: GuessText }) {
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  return (
    <section className="guess-panel guess-score-panel">
      <h2>{room.phase === 'finished' ? text.finalStandings : text.standings}</h2>
      <table className="guess-scores">
        <thead><tr><th scope="col">{text.playerId}</th><th scope="col">{text.roundPoints}</th><th scope="col">{text.totalScore}</th></tr></thead>
        <tbody>
          {ranked.map((player) => (
            <tr key={player.playerId}>
              <th scope="row">
                <span className="guess-rank">{1 + ranked.filter((other) => other.score > player.score).length}</span>
                {player.playerId}{player.playerId === room.viewerId && <small className="guess-muted"> · {text.you}</small>}
              </th>
              <td>{player.roundPoints ?? '—'}</td>
              <td><strong>{player.score}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function GuessRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const { text, language, changeLanguage } = useGuessLanguage();
  const roomPath = `/rooms/${roomId}`;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [room, setRoom] = useState<GuessRoomView | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<CardInfo | null>(null);
  const [confirm, setConfirm] = useState<'surrender' | 'finish' | null>(null);

  useEffect(() => { setToken(localStorage.getItem(sessionKey(roomId))); }, [roomId]);
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
      }
      setConnectionError(err);
    }
  }, [roomId, roomPath, token]);
  useGuessPolling(token && room?.phase !== 'finished' ? refresh : null, 1500);

  const round = room?.round;
  useEffect(() => {
    setSelected(null);
    return () => closeCardPreview();
  }, [round]);

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
        setSelected(null);
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
  const canGuess = room?.phase === 'playing' && room.currentPlayerId === room.viewerId;
  const canSurrender = canGuess && room.players.filter((player) => player.roundPoints === null).length === 1;
  const canFinish = host && room?.phase === 'between_rounds';
  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head">
        <div className="min-w-0">
          <p className="guess-kicker">{text.roomCode} <span>{roomId}</span></p>
          <h1>{room?.name ?? text.join}</h1>
        </div>
        <button type="button" className="guess-secondary" onClick={() => void copyLink()}>
          {copied ? text.copied : text.copy}
        </button>
      </header>
      {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
      {connectionError != null && <p className="guess-error" role="alert">{guessError(connectionError, text)}</p>}
      {token === undefined || (token && !room) ? <p className="guess-muted" role="status">{text.loading}</p> : null}
      {token === null && (
        <form className="guess-panel guess-fields max-w-md" onSubmit={join}>
          <label>{text.playerId}<input className="guess-input" required maxLength={24} value={playerId}
            onChange={(event) => setPlayerId(event.target.value)} /></label>
          <button className="guess-primary" type="submit" disabled={busy}>{text.join}</button>
        </form>
      )}
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
          <GuessTable room={room} text={text} />
          {room.phase === 'playing' && (
            <section className="guess-panel guess-play">
              <h2>{text.pool} <span className="guess-muted">({room.poolCount.toLocaleString(language)})</span></h2>
              <p className="guess-muted">{text.guessHelp}</p>
              {canGuess && <div className="guess-actions">
                <p className={selected ? 'font-semibold' : 'guess-muted'}>{selected?.name ?? text.pickFirst}</p>
                <button type="button" className="guess-primary" disabled={!selected || busy}
                  onClick={() => selected && void act({ action: 'guess', version: room.version, code: selected.code })}>{text.guess}</button>
                {canSurrender && <button type="button" className="guess-secondary" disabled={busy}
                  onClick={() => setConfirm('surrender')}>{text.surrender}</button>}
              </div>}
              <GuessCards key={room.round} text={text} path={`${roomPath}/cards`} token={token} mode="select"
                selected={new Set(selected ? [selected.code] : [])} enabled={canGuess && !busy} choose={setSelected} />
            </section>
          )}
          {room.phase === 'between_rounds' && (
            <section className="guess-panel guess-play">
              <h2>{text.roundOver}</h2>
              {host ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="guess-primary" disabled={busy}
                    onClick={() => void act({ action: 'next', version: room.version })}>{text.next}</button>
                  <button type="button" className="guess-secondary" disabled={busy}
                    onClick={() => setConfirm('finish')}>{text.finish}</button>
                </div>
              ) : <p className="guess-muted">{text.nextHelp}</p>}
            </section>
          )}
          <GuessScores room={room} text={text} />
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
