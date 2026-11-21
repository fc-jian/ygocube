'use client';

import { useState } from 'react';
import type { DgRoomView, GuessPublicRoomView, RoomManagementRequest } from '@ygocube/shared';
import { ConfirmModal } from './ConfirmModal';
import { fillText, type GuessText } from './guess/guess-text';

export function RoomRoster({ room, players, text, viewerId, busy, onManage }: {
  room: Pick<GuessPublicRoomView | DgRoomView, 'phase' | 'hostId' | 'version' | 'admissionLocked'>;
  players: readonly { playerId: string; departed?: boolean }[];
  text: GuessText;
  viewerId?: string | null;
  busy?: boolean;
  onManage?: (command: RoomManagementRequest) => void;
}) {
  const [pending, setPending] = useState<Extract<RoomManagementRequest, { playerId: string }> | null>(null);
  const manageSeats = room.phase === 'lobby' || room.phase === 'between_rounds';
  const canManage = onManage && viewerId && viewerId === room.hostId
    && (manageSeats || room.phase === 'reveal' || room.phase === 'relay_reveal');
  return (
    <>
      {canManage && manageSeats && <button type="button" className="guess-secondary justify-self-start" disabled={busy}
        onClick={() => onManage({ action: 'set-admission', locked: !room.admissionLocked, version: room.version })}>
        {room.admissionLocked ? text.unlockSeats : text.lockSeats}
      </button>}
      {manageSeats && room.admissionLocked && <p className="guess-muted" role="status">{text.seatsLocked}</p>}
      <ul className="guess-roster" aria-label={text.activeRoster} aria-live="polite" aria-relevant="all">
        {players.filter((player) => !player.departed).map(({ playerId }) => (
          <li key={playerId}>
            <strong>{playerId}</strong>
            {playerId === room.hostId && <span className="guess-pill">{text.host}</span>}
            {playerId === viewerId && <span className="guess-muted">{text.you}</span>}
            {canManage && playerId !== viewerId && <div className="ms-auto flex flex-wrap gap-1">
              <button type="button" className="guess-secondary" disabled={busy}
                aria-label={fillText(text.transferPlayer, { player: playerId })}
                onClick={() => setPending({ action: 'transfer-host', playerId, version: room.version })}>{text.transfer}</button>
              {manageSeats && <button type="button" className="guess-secondary" disabled={busy}
                aria-label={fillText(text.removePlayer, { player: playerId })}
                onClick={() => setPending({ action: 'remove', playerId, version: room.version })}>{text.remove}</button>}
            </div>}
          </li>
        ))}
      </ul>
      {canManage && pending && pending.version === room.version &&
        <ConfirmModal open title={fillText(pending.action === 'remove' ? text.removePlayer : text.transferPlayer, { player: pending.playerId })}
          confirmText={pending.action === 'remove' ? text.remove : text.transfer} cancelText={text.cancel}
          onCancel={() => setPending(null)} onConfirm={() => { setPending(null); onManage(pending); }}>
          <p>{pending.action === 'transfer-host' ? text.transferHelp : room.phase === 'lobby' ? text.removeLobbyHelp : text.removeHelp}</p>
        </ConfirmModal>}
    </>
  );
}
