import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../src/config';
import { CardsService } from '../src/cards/cards.service';
import { ApiController } from '../src/api.controller';

// Low-res avif endpoint (GET /pics/:code.avif): served from config.pics.avifDir.
describe('pics avif', () => {
  let dir: string;
  let cards: CardsService;
  const origAvifDir = config.pics.avifDir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-avif-'));
    fs.writeFileSync(path.join(dir, '10000.avif'), Buffer.from([0, 0, 0, 0]));
    config.pics.avifDir = dir;
    cards = new CardsService();
  });

  afterEach(() => {
    config.pics.avifDir = origAvifDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeRes() {
    const r: any = {
      statusCode: 200,
      sent: null as string | null,
      headers: {} as Record<string, string>,
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      end() {},
      setHeader(k: string, v: string) {
        r.headers[k] = v;
      },
      sendFile(f: string) {
        r.sent = f;
      },
    };
    return r;
  }

  const controller = () => new ApiController(null as any, null as any, null as any, null as any, cards, null as any, null as any);

  it('resolveAvifPath finds an existing thumbnail', () => {
    expect(cards.resolveAvifPath(10000)).toBe(path.join(dir, '10000.avif'));
    expect(cards.resolveAvifPath(99999)).toBeNull();
  });

  it('serves the avif with cache headers', () => {
    const res = fakeRes();
    controller().picAvif('10000', res);
    expect(res.sent).toBe(path.join(dir, '10000.avif'));
    expect(res.headers['Cache-Control']).toContain('max-age');
    expect(res.headers['Content-Type']).toBe('image/avif');
  });

  it('404s for unknown or invalid codes', () => {
    let res = fakeRes();
    controller().picAvif('99999', res);
    expect(res.statusCode).toBe(404);
    expect(res.sent).toBeNull();
    res = fakeRes();
    controller().picAvif('abc', res);
    expect(res.statusCode).toBe(404);
  });

  it('404s when avif dir is empty/missing', () => {
    config.pics.avifDir = path.join(dir, 'nope');
    const res = fakeRes();
    controller().picAvif('10000', res);
    expect(res.statusCode).toBe(404);
  });
});
