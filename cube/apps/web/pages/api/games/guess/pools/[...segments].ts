import { proxyGuessPool } from '@/lib/server/guess-pool-proxy';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };
export default proxyGuessPool;
