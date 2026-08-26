import { clientAddress, rateLimitCategory, rateLimitFor } from '../src/rate-limit';

type FakeRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
};

function request(
  path: string,
  remoteAddress = '127.0.0.1',
  headers: FakeRequest['headers'] = {},
): FakeRequest {
  return { path, headers, socket: { remoteAddress } };
}

describe('rate limit policy', () => {
  it('puts card thumbnails in a high-capacity isolated bucket', () => {
    expect(rateLimitCategory(request('/pics/89631139.avif'))).toBe('asset');
    expect(rateLimitCategory(request('/pics'))).toBe('asset');
    expect(rateLimitFor('asset')).toBeGreaterThan(rateLimitFor('public'));
  });

  it('keeps privileged and tournament APIs stricter than public reads', () => {
    expect(rateLimitCategory(request('/admin/tournaments'))).toBe('privileged');
    expect(rateLimitCategory(request('/tournaments'))).toBe('privileged');
    expect(rateLimitCategory(request('/t/12/cards'))).toBe('tournament');
    expect(rateLimitFor('privileged')).toBeLessThan(rateLimitFor('public'));
    expect(rateLimitFor('tournament')).toBeLessThan(rateLimitFor('public'));
  });

  it('uses the real client address behind the local reverse proxy', () => {
    expect(clientAddress(request('/pics/a', '127.0.0.1', {
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.4, 127.0.0.1',
    }))).toBe('203.0.113.10');
    expect(clientAddress(request('/pics/a', '::1', {
      'x-forwarded-for': '198.51.100.4, 127.0.0.1',
    }))).toBe('198.51.100.4');
  });

  it('ignores forwarded-address spoofing from direct clients', () => {
    expect(clientAddress(request('/pics/a', '198.51.100.20', {
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.11',
    }))).toBe('198.51.100.20');
    expect(clientAddress(request('/pics/a', '127.0.0.1', {
      'x-real-ip': 'not-an-ip',
    }))).toBe('127.0.0.1');
  });
});
