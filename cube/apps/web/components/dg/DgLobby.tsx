'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useState } from 'react';
import {
  DG_DEFAULT_ROUND_SECONDS, DG_DEFAULT_SECONDS, DG_MAX_SECONDS, DG_MIN_SECONDS,
  type DgCreateRequest, type DgMode, type DgRoomSummary, type DgSession, type GuessPoolSummary,
} from '@ygocube/shared';
import { GuessFrame, useGuessLanguage } from '@/components/guess/GuessFrame';
import { GUESS_PATH, useGuessPolling, useGuessResource } from '@/components/guess/guess-client';
import { fillText } from '@/components/guess/guess-text';
import { DG_PATH, dgError, dgRequest, dgSessionKey } from './dg-client';
import { dgText } from './dg-text';

export function DgLobby() {
  const router = useRouter();
  const { language, changeLanguage, text: shared } = useGuessLanguage();
  const text = dgText[language];
  const [mode, setMode] = useState<DgMode>('classic');
  const isRelay = mode === 'relay';
  const [chosenPool, setChosenPool] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [listError, setListError] = useState(false);
  const [rooms, setRooms] = useState<DgRoomSummary[] | null>(null);
  const { data: pools, error: poolError } = useGuessResource<GuessPoolSummary[]>('/pools');
  const poolId = chosenPool ?? pools?.find((pool) => pool.isDefault)?.poolId ?? 0;

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await dgRequest<DgRoomSummary[]>('/rooms', { signal });
      if (!signal.aborted) {
        setRooms(result);
        setListError(false);
      }
    } catch {
      if (!signal.aborted) setListError(true);
    }
  }, []);
  useGuessPolling(refresh, 4000);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: DgCreateRequest = {
      name: String(form.get('name')), playerId: String(form.get('playerId')), poolId, mode,
      ...(isRelay ? {
        drawSeconds: Number(form.get('drawSeconds')), guessSeconds: Number(form.get('guessSeconds')),
      } : {
        roundSeconds: Number(form.get('roundSeconds')), hintsEnabled: form.has('hintsEnabled'),
      }),
    };
    setBusy(true);
    setCreateError(null);
    try {
      const { token, room } = await dgRequest<DgSession>('/rooms', { body });
      localStorage.setItem(dgSessionKey(room.roomId), token);
      router.push(`${DG_PATH}/${room.roomId}`);
    } catch (error) {
      setCreateError(error);
    } finally {
      setBusy(false);
    }
  }

  function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('roomCode')).toUpperCase();
    router.push(`${DG_PATH}/${code}`);
  }

  return (
    <GuessFrame language={language} changeLanguage={changeLanguage} lobby={{ href: DG_PATH, label: shared.lobby }}>
      <header className="guess-room-head"><h1>Draw &amp; Guess</h1></header>
      <p className="guess-muted">{isRelay ? text.relay.intro : text.intro}</p>
      <div className="guess-columns">
        <section className="guess-panel" aria-labelledby="dg-create-title">
          <h2 id="dg-create-title">{shared.create}</h2>
          <form className="guess-fields" onSubmit={create}>
            <label>{shared.roomName}<input name="name" className="guess-input" required maxLength={48} /></label>
            <label>{shared.playerId}<input name="playerId" className="guess-input" required maxLength={24} /></label>
            <label>{text.mode}<select name="mode" className="guess-input" value={mode}
              onChange={(event) => setMode(event.target.value === 'relay' ? 'relay' : 'classic')}>
              <option value="classic">{text.classic}</option>
              <option value="relay">{text.relay.mode}</option>
            </select></label>
            <label>{shared.pool}<select name="poolId" className="guess-input" value={poolId} disabled={!pools}
              onChange={(event) => setChosenPool(Number(event.target.value))}>
              {!pools && <option value={0}>{poolError == null ? shared.loading : '—'}</option>}
              {pools?.map((pool) => <option key={pool.poolId} value={pool.poolId}>
                {pool.poolId === 0 ? shared.fullPool : pool.name}{pool.isDefault && ` (${shared.defaultPool})`}
                {' · '}{fillText(shared.cardCount, { count: pool.cardCount })}
              </option>)}
            </select></label>
            <Link className="guess-nav-link justify-self-start" href={`${GUESS_PATH}/pools/new`}>{shared.createPool}</Link>
            {isRelay ? <div className="grid grid-cols-2 gap-3">
              <label>{text.drawTime}<input className="guess-input" type="number" name="drawSeconds" required
                defaultValue={DG_DEFAULT_SECONDS} min={DG_MIN_SECONDS} max={DG_MAX_SECONDS} /></label>
              <label>{text.guessTime}<input className="guess-input" type="number" name="guessSeconds" required
                defaultValue={DG_DEFAULT_SECONDS} min={DG_MIN_SECONDS} max={DG_MAX_SECONDS} /></label>
            </div> : <>
              <label>{text.roundTime}<input className="guess-input" type="number" name="roundSeconds" required
                defaultValue={DG_DEFAULT_ROUND_SECONDS} min={DG_MIN_SECONDS} max={DG_MAX_SECONDS} /></label>
              <label className="dg-check"><input name="hintsEnabled" type="checkbox" defaultChecked />{text.hintsEnabled}</label>
            </>}
            {(createError ?? poolError) != null && (
              <p className="guess-error" role="alert">{dgError(createError ?? poolError, text, shared)}</p>
            )}
            <button className="guess-primary w-full" type="submit" disabled={busy || !pools}>{shared.create}</button>
          </form>
        </section>
        <section className="guess-panel" aria-labelledby="dg-open-title">
          <h2 id="dg-open-title">{shared.openRooms}</h2>
          <form onSubmit={enter} className="guess-fields">
            <label>{shared.roomCode}
              <span className="guess-inline">
                <input name="roomCode" className="guess-input font-mono uppercase" required maxLength={8}
                  pattern="[A-Fa-f0-9]{8}" placeholder="A1B2C3D4" />
                <button className="guess-secondary" type="submit">{shared.enter}</button>
              </span>
            </label>
          </form>
          {listError && <p className="guess-error" role="alert">{shared.genericError}</p>}
          {!listError && rooms === null && <p className="guess-muted">{shared.loading}</p>}
          {!listError && rooms?.length === 0 && <p className="guess-muted">{shared.noRooms}</p>}
          <ul className="guess-open-rooms">
            {rooms?.map((room) => <li key={room.roomId}>
              <Link href={`${DG_PATH}/${room.roomId}`}>
                <span className="min-w-0">
                  <strong className="block truncate">{room.name}</strong>
                  <span className="guess-muted"><span className="font-mono">{room.roomId}</span>
                    {' · '}{room.mode === 'relay' ? text.relay.mode : text.classic}
                    {' · '}{room.poolId === 0 ? shared.fullPool : room.poolName}</span>
                </span>
                <span className="guess-pill">{room.playerCount}/{room.maxPlayers}</span>
              </Link>
            </li>)}
          </ul>
        </section>
      </div>
    </GuessFrame>
  );
}
