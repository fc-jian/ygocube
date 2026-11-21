'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { readGameValue, recentGameRooms, type RoomGame } from '@/lib/gameStorage';
import type { GuessText } from './guess/guess-text';

export function RecentGameRooms({ game, text }: { game: RoomGame; text: GuessText }) {
  const [rooms, setRooms] = useState<{ id: string; name: string; hasSeat: boolean }[]>([]);
  useEffect(() => {
    function refresh() {
      setRooms(recentGameRooms(game).map((room) => ({
        ...room, hasSeat: !!readGameValue(`yc_${game}_session_${room.id}`),
      })));
    }
    function changed(event: StorageEvent) {
      if (!event.key || event.key.startsWith(`yc_${game}_`)) refresh();
    }
    refresh();
    window.addEventListener('storage', changed);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('pageshow', refresh);
    };
  }, [game]);
  if (!rooms.length) return null;
  return <section className="guess-panel mb-4" aria-label={text.recentRooms}>
    <h2>{text.recentRooms}</h2>
    <ul className="guess-open-rooms">
      {rooms.map((room) => <li key={room.id}>
        <Link href={`/games/${game}/${room.id}`} prefetch={false}>
          <span className="min-w-0 break-words">{room.name && <strong>{room.name} </strong>}
            <span className="guess-muted font-mono">{room.id}</span></span>
          <span className="shrink-0">{room.hasSeat ? text.returnRoom : text.watchRoom}</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}
