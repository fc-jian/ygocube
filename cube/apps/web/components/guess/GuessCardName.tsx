'use client';

import type { GuessCardRef } from '@ygocube/shared';
import { useRef } from 'react';
import { hideCardPreview, moveCardPreview, pinCardPreview, showCardPreview } from '@/components/CardPreview';
import { fetchCardMetadata } from '@/lib/cardCache';
import type { CardInfo } from '@/lib/types';
import { GUESS_PATH } from './guess-client';
import { fillText, GuessText } from './guess-text';

type PreviewPoint = { clientX: number; clientY: number };
let lastPinRequest = 0;

export function GuessCardName({ card, text }: { card: GuessCardRef; text: GuessText }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const hover = useRef<PreviewPoint | null>(null);
  const details = useRef<Promise<CardInfo | undefined> | null>(null);

  function readDetails() {
    if (!details.current) {
      details.current = fetchCardMetadata(`${GUESS_PATH}/card-details`, [card.code], null)
        .then(([info]) => info, () => undefined);
      void details.current.then((info) => { if (!info) details.current = null; });
    }
    return details.current;
  }

  return (
    <button type="button" ref={anchor} className="guess-card-name" data-guess-card-name={card.code}
      aria-label={fillText(text.cardDetails, { card: card.name })}
      onMouseEnter={({ clientX, clientY }) => {
        hover.current = { clientX, clientY };
        void readDetails().then((info) => {
          if (info && hover.current && anchor.current?.isConnected) showCardPreview(info, hover.current);
        });
      }}
      onMouseMove={({ clientX, clientY }) => {
        hover.current = { clientX, clientY };
        moveCardPreview(hover.current);
      }}
      onMouseLeave={() => { hover.current = null; hideCardPreview(); }}
      onClick={({ clientX, clientY }) => {
        const pinRequest = ++lastPinRequest;
        void readDetails().then((info) => {
          if (info && pinRequest === lastPinRequest && anchor.current?.isConnected) {
            pinCardPreview(info, { clientX, clientY });
          }
        });
      }}>
      {card.name}
    </button>
  );
}
