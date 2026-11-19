import { notFound } from 'next/navigation';
import { GuessPoolDetail } from '@/components/guess/GuessPools';

export default function GuessPoolPage({ params }: { params: { poolId: string } }) {
  const poolId = Number(params.poolId);
  if (!/^\d+$/.test(params.poolId) || !Number.isSafeInteger(poolId)) notFound();
  return <GuessPoolDetail key={poolId} poolId={poolId} />;
}
