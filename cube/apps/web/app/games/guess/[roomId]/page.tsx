import { notFound } from 'next/navigation';
import { GuessRoom } from '@/components/guess/GuessRoom';

export default function GuessRoomPage({ params }: { params: { roomId: string } }) {
  const roomId = params.roomId.toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(roomId)) notFound();
  return <GuessRoom key={roomId} roomId={roomId} />;
}
