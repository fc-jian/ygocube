import { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { compressJsonResponse } from '../src/response-compression';

interface MockResult {
  headers: Map<string, unknown>;
  body: Buffer;
}

function runMiddleware(path: string, acceptEncoding: string | undefined, writeBody: (res: Response) => void): Promise<MockResult> {
  const headers = new Map<string, unknown>();
  let body = Buffer.alloc(0);
  let finish: ((result: MockResult) => void) | null = null;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    write(chunk: Buffer | string) { body = Buffer.concat([body, Buffer.from(chunk)]); return true; },
    end(chunk?: Buffer | string, callback?: () => void) {
      if (chunk !== undefined) body = Buffer.concat([body, Buffer.from(chunk)]);
      callback?.();
      finish?.({ headers, body });
      return this;
    },
  } as unknown as Response;
  const request = { method: 'GET', path, headers: { 'accept-encoding': acceptEncoding } } as unknown as Request;
  return new Promise((resolve) => {
    finish = resolve;
    compressJsonResponse(request, response, () => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      writeBody(response);
    });
  });
}

describe('compressJsonResponse', () => {
  const payload = JSON.stringify({ payload: 'x'.repeat(2_000) });

  it('compresses JSON only when the client advertises gzip', async () => {
    const response = await runMiddleware('/json', 'gzip, deflate', (res) => res.end(payload));
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    expect(gunzipSync(response.body).toString('utf8')).toBe(payload);
  });

  it('keeps JSON readable without gzip support', async () => {
    const response = await runMiddleware('/json', undefined, (res) => res.end(payload));
    expect(response.headers.get('content-encoding')).toBeUndefined();
    expect(response.body.toString('utf8')).toBe(payload);
  });

  it('never buffers or compresses the SSE path', async () => {
    const response = await runMiddleware('/stream', 'gzip', (res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hello\n\n');
      res.end();
    });
    expect(response.headers.get('content-encoding')).toBeUndefined();
    expect(response.body.toString('utf8')).toBe('data: hello\n\n');
  });

  it('streams oversized responses instead of retaining an unbounded buffer', async () => {
    const first = 'a'.repeat(1_500_000);
    const second = 'b'.repeat(1_000_000);
    const response = await runMiddleware('/json', 'gzip', (res) => {
      res.write(first);
      res.end(second);
    });
    expect(response.headers.get('content-encoding')).toBeUndefined();
    expect(response.body.toString('utf8')).toBe(first + second);
  });
});
