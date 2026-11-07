'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useState } from 'react';
import type { GuessCreateRequest, GuessPoolSummary, GuessRoomSummary, GuessSession } from '@ygocube/shared';
import { GuessFrame, useGuessLanguage } from './GuessFrame';
import { GUESS_PATH, guessError, guessRequest, sessionKey, useGuessPolling, useGuessResource } from './guess-client';
import { fillText } from './guess-text';

export function GuessLobby() {
  const router = useRouter();
  const { text, language, changeLanguage } = useGuessLanguage();
  const [name, setName] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [poolId, setPoolId] = useState(0);
  const [roomCode, setRoomCode] = useState('');
  const [rooms, setRooms] = useState<GuessRoomSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [joinError, setJoinError] = useState(false);
  const [listError, setListError] = useState(false);
  const { data: pools, error: poolError } = useGuessResource<GuessPoolSummary[]>('/pools');

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await guessRequest<GuessRoomSummary[]>('/rooms', { signal });
      if (!signal.aborted) {
        setRooms(result);
        setListError(false);
      }
    } catch {
      if (!signal.aborted) setListError(true);
    }
  }, []);
  useGuessPolling(refresh, 4000);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreateError('');
    const body: GuessCreateRequest = { name, playerId, poolId };
    setBusy(true);
    try {
      const { token, room } = await guessRequest<GuessSession>('/rooms', { body });
      localStorage.setItem(sessionKey(room.roomId), token);
      router.push(`${GUESS_PATH}/${room.roomId}`);
    } catch (err) {
      setCreateError(guessError(err, text));
    } finally {
      setBusy(false);
    }
  }

  function enter(event: FormEvent) {
    event.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code)) {
      setJoinError(true);
      return;
    }
    router.push(`${GUESS_PATH}/${code}`);
  }

  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head"><h1>Guess the Card</h1></header>
      <div className="guess-columns">
        <section className="guess-panel" aria-labelledby="guess-create-title">
          <h2 id="guess-create-title">{text.create}</h2>
          <form className="guess-fields" onSubmit={create}>
            <label>{text.roomName}<input className="guess-input" required maxLength={48} value={name}
              onChange={(event) => setName(event.target.value)} /></label>
            <label>{text.playerId}<input className="guess-input" required maxLength={24} value={playerId}
              onChange={(event) => setPlayerId(event.target.value)} /></label>
            <label>{text.pool}<select className="guess-input" value={poolId} required disabled={!pools}
              onChange={(event) => setPoolId(Number(event.target.value))}>
              {!pools && <option value={0}>{poolError == null ? text.loading : '—'}</option>}
              {pools?.map((pool) => <option key={pool.poolId} value={pool.poolId}>
                {pool.poolId === 0 ? text.fullPool : pool.name} · {fillText(text.cardCount, { count: pool.cardCount })}
              </option>)}
            </select></label>
            <Link className="guess-nav-link justify-self-start" href={`${GUESS_PATH}/pools/new`}>{text.createPool}</Link>
            {poolError != null && <p className="guess-error" role="alert">{guessError(poolError, text)}</p>}
            {createError && <p className="guess-error" role="alert">{createError}</p>}
            <button type="submit" className="guess-primary w-full" disabled={busy || !pools}>{text.create}</button>
          </form>
        </section>
        <section className="guess-panel" aria-labelledby="guess-open-title">
          <h2 id="guess-open-title">{text.openRooms}</h2>
          <form onSubmit={enter} className="guess-fields">
            <label>{text.roomCode}
              <span className="guess-inline">
                <input className="guess-input font-mono uppercase" required maxLength={8} placeholder="A1B2C3D4"
                  value={roomCode} onChange={(event) => { setRoomCode(event.target.value); setJoinError(false); }} />
                <button className="guess-secondary" type="submit">{text.enter}</button>
              </span>
            </label>
          </form>
          {joinError && <p className="guess-error" role="alert">{text.invalidRoomCode}</p>}
          {listError && <p className="guess-error" role="alert">{text.genericError}</p>}
          {!listError && rooms === null && <p className="guess-muted">{text.loading}</p>}
          {!listError && rooms?.length === 0 && <p className="guess-muted">{text.noRooms}</p>}
          <ul className="guess-open-rooms">
            {rooms?.map((room) => (
              <li key={room.roomId}>
                <Link href={`${GUESS_PATH}/${room.roomId}`}>
                  <span className="min-w-0">
                    <strong className="block truncate">{room.name}</strong>
                    <span className="guess-muted"><span className="font-mono">{room.roomId}</span>
                      {' · '}{room.poolId === 0 ? text.fullPool : room.poolName}
                    </span>
                  </span>
                  <span className="guess-pill">{room.playerCount}/{room.maxPlayers}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </GuessFrame>
  );
}
