'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import type { GuessPoolCreateRequest, GuessPoolSummary } from '@ygocube/shared';
import { GuessCards } from './GuessCards';
import { GuessFrame, useGuessLanguage } from './GuessFrame';
import { GUESS_PATH, guessError, guessRequest, useGuessResource } from './guess-client';
import { fillText } from './guess-text';

const POOL_PATH = `${GUESS_PATH}/pools`;

export function GuessPoolDirectory() {
  const { language, changeLanguage, text } = useGuessLanguage();
  const { data, error } = useGuessResource<GuessPoolSummary[]>('/pools');
  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head">
        <h1>{text.pools}</h1>
        <Link className="guess-primary" href={`${POOL_PATH}/new`}>{text.createPool}</Link>
      </header>
      {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
      {!data && error == null && <p className="guess-muted" role="status">{text.loading}</p>}
      {data && <ul className="guess-open-rooms max-w-3xl">
        {data.map((pool) => (
          <li key={pool.poolId}>
            <Link href={`${POOL_PATH}/${pool.poolId}`}>
              <strong className="min-w-0 truncate">{pool.poolId === 0 ? text.fullPool : pool.name}</strong>
              <span className="guess-pill">{fillText(text.cardCount, { count: pool.cardCount.toLocaleString(language) })}</span>
            </Link>
          </li>
        ))}
      </ul>}
    </GuessFrame>
  );
}

export function GuessPoolCreator() {
  const router = useRouter();
  const { language, changeLanguage, text } = useGuessLanguage();
  const [name, setName] = useState('');
  const [codesText, setCodesText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const entries = codesText.normalize('NFKC').split(/[,、\s]+/u).filter(Boolean);
  const codes = new Set(entries.map(Number));

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const invalidCodes = codes.size < 2 || entries.some((entry) => !/^\d+$/.test(entry));
    setInvalid(invalidCodes);
    if (invalidCodes) return;
    setBusy(true);
    try {
      const body: GuessPoolCreateRequest = { name, codes: [...codes] };
      const pool = await guessRequest<GuessPoolSummary>('/pools', { body });
      router.push(`${POOL_PATH}/${pool.poolId}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head"><h1>{text.createPool}</h1></header>
      <section className="guess-panel max-w-3xl">
        <form id="guess-create-pool" className="guess-fields" onSubmit={create}>
          <label>{text.poolName}<input className="guess-input" value={name} required maxLength={48}
            onChange={(event) => setName(event.target.value)} /></label>
          <label>{text.codes} ({codes.size})
            <textarea className="guess-input" rows={3} maxLength={250_000} value={codesText}
              aria-describedby="guess-code-hint" onChange={(event) => setCodesText(event.target.value)} />
            <span className="guess-muted" id="guess-code-hint">{text.poolHint} {text.codeHint}</span>
          </label>
        </form>
        <GuessCards text={text} path="/cards" selected={codes} mode="add"
          choose={(card) => setCodesText((value) => `${value.trim()} ${card.code}`.trim())} />
        {invalid && <p className="guess-error" role="alert">{text.errors.GUESS_INVALID_POOL}</p>}
        {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
        <button form="guess-create-pool" type="submit" className="guess-primary self-start" disabled={busy}>{text.createPool}</button>
      </section>
    </GuessFrame>
  );
}

export function GuessPoolDetail({ poolId }: { poolId: number }) {
  const { language, changeLanguage, text } = useGuessLanguage();
  const path = `/pools/${poolId}`;
  const { data, error } = useGuessResource<GuessPoolSummary>(path);
  return (
    <GuessFrame language={language} changeLanguage={changeLanguage}>
      <header className="guess-room-head">
        <h1>{data ? data.poolId === 0 ? text.fullPool : data.name : text.pools}</h1>
        {data && <span className="guess-pill">{fillText(text.cardCount, { count: data.cardCount.toLocaleString(language) })}</span>}
      </header>
      {error != null && <p className="guess-error" role="alert">{guessError(error, text)}</p>}
      {!data && error == null && <p className="guess-muted" role="status">{text.loading}</p>}
      {data && <section className="guess-panel max-w-3xl">
        <p className="guess-muted">{text.statsHelp}</p>
        <GuessCards text={text} path={`${path}/cards`} mode="browse" />
      </section>}
    </GuessFrame>
  );
}
