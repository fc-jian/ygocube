'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DgActionRequest, DgRoomView, DgSession } from '@ygocube/shared';
import { GuessFrame, useGuessLanguage } from '@/components/guess/GuessFrame';
import { useGuessPolling } from '@/components/guess/guess-client';
import { fillText, guessText, type GuessLanguage } from '@/components/guess/guess-text';
import { ApiError } from '@/lib/api';
import { DgRelay } from './DgRelay';
import { DgTurn } from './DgTurn';
import { DG_PATH, dgError, dgRequest, dgSessionKey } from './dg-client';
import { dgText } from './dg-text';

export function DgRoom({ roomId }: { roomId: string }) {
  const { language, changeLanguage, text } = useGuessLanguage();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setToken(localStorage.getItem(dgSessionKey(roomId)));
  }, [roomId]);

  const updateToken = useCallback((value: string | null) => {
    const key = dgSessionKey(roomId);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    setToken(value);
  }, [roomId]);

  return (
    <GuessFrame language={language} changeLanguage={changeLanguage} lobby={{ href: DG_PATH, label: text.lobby }}>
      {token === undefined ? <p className="guess-muted">{text.loading}</p>
        : <DgRoomSession key={token === null ? 'spectator' : 'player'} roomId={roomId} token={token}
            updateToken={updateToken} language={language} />}
    </GuessFrame>
  );
}

function DgRoomSession({ roomId, token, updateToken, language }: {
  roomId: string;
  token: string | null;
  updateToken: (value: string | null) => void;
  language: GuessLanguage;
}) {
  const router = useRouter();
  const text = dgText[language];
  const shared = guessText[language];
  const path = `/rooms/${roomId}`;
  const [snapshot, setSnapshot] = useState<{ room: DgRoomView; receivedAt: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const accept = useCallback((room: DgRoomView) => {
    const receivedAt = performance.now();
    setSnapshot((previous) => previous && (previous.room.version > room.version
      || (previous.room.version === room.version && previous.room.serverNow > room.serverNow))
      ? previous : { room, receivedAt });
    setLoadError(null);
  }, []);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const room = await dgRequest<DgRoomView>(path, { token: token ?? undefined, signal });
      if (!signal.aborted) accept(room);
    } catch (error) {
      if (signal.aborted) return;
      if (token && error instanceof ApiError && error.status === 401) updateToken(null);
      else setLoadError(error);
    }
  }, [accept, path, token, updateToken]);
  const room = snapshot?.room;
  const missing = loadError instanceof ApiError && loadError.status === 404;
  useGuessPolling(missing || room?.phase === 'finished' ? null : refresh, room?.phase === 'lobby' ? 1500 : 800);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const playerId = String(new FormData(event.currentTarget).get('playerId'));
    setActionError(null);
    setBusy(true);
    try {
      const session = await dgRequest<DgSession>(`${path}/join`, { body: { playerId } });
      updateToken(session.token);
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  }

  async function run(command: DgActionRequest): Promise<boolean> {
    if (!token || busy) return false;
    setActionError(null);
    setBusy(true);
    try {
      const result = await dgRequest<DgRoomView | null>(`${path}/action`, { token, body: command });
      if (result) accept(result);
      else {
        updateToken(null);
        router.push(DG_PATH);
      }
      return true;
    } catch (error) {
      setActionError(error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${DG_PATH}/${roomId}`);
      setCopied(true);
    } catch (error) {
      setActionError(error);
    }
  }

  const error = actionError ?? loadError;
  if (!room || !snapshot) {
    return <p className={error ? 'guess-error' : 'guess-muted'} role={error ? 'alert' : 'status'}>
      {error ? dgError(error, text, shared) : shared.loading}
    </p>;
  }
  const isHost = room.viewerId !== null && room.viewerId === room.hostId;
  const isRelay = room.mode === 'relay';

  return (
    <>
      <header className="guess-room-head">
        <div className="min-w-0">
          <p className="guess-kicker">Draw &amp; Guess <span>{room.roomId}</span></p>
          <h1>{room.name}</h1>
          <p className="guess-muted break-words">
            {room.poolId === 0 ? shared.fullPool : room.poolName} · {isRelay ? text.relay.mode : text.classic} · {fillText(isRelay ? text.relay.settings : text.settings, {
              draw: room.settings.drawSeconds, guess: room.settings.guessSeconds,
              hints: room.settings.hintsEnabled ? text.hintsOn : text.hintsOff,
            })}{!token && ` · ${shared.spectate}`}
          </p>
        </div>
        <button type="button" className="guess-secondary" onClick={() => void copy()}>{copied ? shared.copied : shared.copy}</button>
      </header>
      {error != null && <p className="guess-error mb-3" role="alert">{dgError(error, text, shared)}</p>}
      {room.phase === 'lobby' && <section className="guess-panel guess-waiting">
        <h2>{shared.waiting} <span className="guess-pill">{room.playerCount}/{room.maxPlayers}</span></h2>
        <ul className="guess-roster">
          {room.players.map(({ playerId }) => <li key={playerId}>
            <strong>{playerId}</strong>
            {playerId === room.hostId && <span className="guess-pill">{shared.host}</span>}
            {playerId === room.viewerId && <span className="guess-muted">{shared.you}</span>}
          </li>)}
        </ul>
        {token ? <>
          <p className="guess-muted">{room.playerCount < 2 ? text.waitForPlayers
            : isHost ? (isRelay ? text.relay.intro : text.intro) : text.waitForHost}</p>
          <div className="flex flex-wrap gap-2">
            {isHost && <button type="button" className="guess-primary" disabled={busy || room.playerCount < 2}
              onClick={() => void run({ action: 'start' })}>{shared.start}</button>}
            <button type="button" className="guess-secondary" disabled={busy}
              onClick={() => void run({ action: 'leave' })}>{shared.leave}</button>
          </div>
        </> : room.playerCount < room.maxPlayers ? (
          <form className="guess-fields" onSubmit={join}>
            <label>{shared.playerId}<input className="guess-input" name="playerId" required maxLength={24} /></label>
            <button className="guess-primary" type="submit" disabled={busy}>{shared.join}</button>
          </form>
        ) : <p className="guess-muted">{text.fullRoom}</p>}
      </section>}
      {room.turn && <DgTurn room={room} turn={room.turn} receivedAt={snapshot.receivedAt}
        token={token} language={language} busy={busy} run={run} />}
      {room.relay && <DgRelay room={room} receivedAt={snapshot.receivedAt} token={token} language={language} busy={busy} run={run} />}
      {room.phase === 'finished' && !room.turn && !room.relay && <p className="guess-muted">{text.lobbyClosed}</p>}
    </>
  );
}
