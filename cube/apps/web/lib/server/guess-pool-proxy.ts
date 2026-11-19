import type { NextApiRequest, NextApiResponse } from 'next';

// The local Next rewrite would otherwise preserve a browser-supplied IP header.
// Pool requests pass through this handler so the API sees the connection's IP.
// This Pages API route has no Pages UI. App Router useParams callers keep their
// non-null guarantee despite Next's project-wide compatibility type overload.
export function poolProxyIp(request: Pick<NextApiRequest, 'socket' | 'headers'>): string | undefined {
  const peer = request.socket.remoteAddress;
  const real = request.headers['x-real-ip'];
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') && typeof real === 'string') return real;
  return peer;
}

export async function proxyGuessPool(request: NextApiRequest, response: NextApiResponse) {
  const segments = request.query.segments;
  if (!Array.isArray(segments) || !/^\d+(?:\/cards(?:\/\d+\/vote)?|\/proposals(?:\/(?:cards|ranking))?|\/export\.csv)?$/.test(segments.join('/'))) {
    response.status(404).json({ ok: false, code: 'GUESS_POOL_NOT_FOUND' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    response.status(405).end();
    return;
  }
  const ip = poolProxyIp(request);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ip) headers['X-Real-IP'] = ip;
  if (request.headers.origin) headers.Origin = request.headers.origin;
  const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
  response.setHeader('Cache-Control', 'no-store');
  try {
    const upstream = await fetch(`${process.env.CUBE_API_URL || 'http://127.0.0.1:3001'}/games/guess/pools/${segments.join('/')}${query}`, {
      method: request.method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: request.method === 'POST' ? JSON.stringify(request.body) : undefined,
    });
    response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) response.setHeader('Content-Disposition', disposition);
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.status(502).json({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
  }
}
