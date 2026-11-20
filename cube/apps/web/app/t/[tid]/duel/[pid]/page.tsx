'use client';

import { useParams } from 'next/navigation';
import { DuelClient } from '@/components/duel/DuelClient';
import { decodePathSegment } from '@/lib/api';

export default function Page() {
  const { tid, pid } = useParams<{ tid: string; pid: string }>()!;
  return <DuelClient key={`${tid}/${pid}`} tid={tid} pid={decodePathSegment(pid)} mode="player" />;
}
