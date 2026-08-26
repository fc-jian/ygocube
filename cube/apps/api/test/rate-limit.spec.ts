import { clientAddress, rateLimitCategory, rateLimitFor } from '../src/rate-limit';

function request(path: string, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) {
  return { path, socket: { remoteAddress }, headers };
}

describe('rate-limit classification', () => {
  it('isolates card thumbnails in a high-capacity asset bucket', () => {
    expect(rateLimitCategory(request('/pics/10000.avif'))).toBe('asset');
    expect(rateLimitFor('asset')).toBeGreaterThanOrEqual(6000);
    expect(rateLimitCategory(request('/pools/kuro750/cards'))).toBe('public');
  });

  it('keeps privileged and tournament APIs on stricter buckets', () => {
    expect(rateLimitCategory(request('/admin/pools'))).toBe('privileged');
    expect(rateLimitCategory(request('/t/36/cards'))).toBe('tournament');
    expect(rateLimitFor('privileged')).toBeLessThan(rateLimitFor('public'));
    expect(rateLimitFor('tournament')).toBeLessThan(rateLimitFor('asset'));
  });

  it('uses the reverse proxy client address for loopback peers', () => {
    expect(clientAddress(request('/pics/1.avif', '127.0.0.1', { 'x-real-ip': '203.0.113.8' }))).toBe('203.0.113.8');
    expect(clientAddress(request('/pics/1.avif', '::1', { 'x-forwarded-for': '2001:db8::8, 127.0.0.1' }))).toBe('2001:db8::8');
  });

  it('does not trust forwarding headers from direct non-loopback peers', () => {
    expect(clientAddress(request('/pics/1.avif', '198.51.100.7', { 'x-real-ip': '203.0.113.8' }))).toBe('198.51.100.7');
    expect(clientAddress(request('/pics/1.avif', '127.0.0.1', { 'x-real-ip': 'not-an-ip' }))).toBe('127.0.0.1');
  });
});
