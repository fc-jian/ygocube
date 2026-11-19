import { notFound } from 'next/navigation';
import { DgRoom } from '@/components/dg/DgRoom';

export default function DgRoomPage({ params }: { params: { roomId: string } }) {
  const roomId = params.roomId.toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(roomId)) notFound();
  return <DgRoom key={roomId} roomId={roomId} />;
}
