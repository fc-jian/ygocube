'use client';

import type { GuessOpeningClue } from '@ygocube/shared';
import { useId, useRef } from 'react';
import { GuessText, openingHintDetails } from './guess-text';

export function GuessHintButton({ hint, text, compact = false }: {
  hint: GuessOpeningClue;
  text: GuessText;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { title, rule } = openingHintDetails(hint, text);
  const label = text.hintGroups[hint.group];
  return (
    <>
      <button type="button" className={compact ? 'guess-hint-trigger guess-seat-hint' : 'guess-hint-trigger guess-pill'}
        data-guess-seat-hint={compact ? '' : undefined} title={`${title}\n${rule}`} aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}>
        {compact ? text.hintShort[hint.group] ?? label : label}
      </button>
      <dialog ref={dialog} className="guess-hint-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-rule`}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-rule`}>{rule}</p>
        <div className="mt-4 flex justify-end">
          <button type="button" className="guess-secondary" onClick={() => dialog.current?.close()}>{text.close}</button>
        </div>
      </dialog>
    </>
  );
}
