'use client';

import { useState } from 'react';
import type { DgRoomView, GuessPublicRoomView, RemoveRoomPlayerRequest } from '@ygocube/shared';
import { ConfirmModal } from './ConfirmModal';
import { fillText, type GuessText } from './guess/guess-text';

export function RoomRoster({ room, players, text, viewerId, busy, onRemove }: {
  room: Pick<GuessPublicRoomView | DgRoomView, 'phase' | 'hostId' | 'version'>;
  players: readonly { playerId: string; departed?: boolean }[];
  text: GuessText;
  viewerId?: string | null;
  busy?: boolean;
  onRemove?: (command: RemoveRoomPlayerRequest) => void;
}) {
  const [pending, setPending] = useState<RemoveRoomPlayerRequest | null>(null);
  const canRemove = onRemove && viewerId && viewerId === room.hostId
    && (room.phase === 'lobby' || room.phase === 'between_rounds');
  return (
    <>
      <ul className="guess-roster" aria-label={text.activeRoster} aria-live="polite">
        {players.filter((player) => !player.departed).map(({ playerId }) => (
          <li key={playerId}>
            <strong>{playerId}</strong>
            {playerId === room.hostId && <span className="guess-pill">{text.host}</span>}
            {playerId === viewerId && <span className="guess-muted">{text.you}</span>}
            {canRemove && playerId !== viewerId && <button type="button" className="guess-secondary" disabled={busy}
              aria-label={fillText(text.removePlayer, { player: playerId })}
              onClick={() => setPending({ action: 'remove', playerId, version: room.version })}>{text.remove}</button>}
          </li>
        ))}
      </ul>
      {canRemove && pending && pending.version === room.version &&
        <ConfirmModal open title={fillText(text.removePlayer, { player: pending.playerId })}
          confirmText={text.remove} cancelText={text.cancel} onCancel={() => setPending(null)}
          onConfirm={() => { setPending(null); onRemove(pending); }}>
          <p>{room.phase === 'lobby' ? text.removeLobbyHelp : text.removeHelp}</p>
        </ConfirmModal>}
    </>
  );
}
