import { gzip } from 'node:zlib';
import { NextFunction, Request, Response } from 'express';

type WritableResponse = Response & {
  write: (...args: any[]) => boolean;
  end: (...args: any[]) => Response;
};

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function acceptsGzip(value: unknown): boolean {
  let wildcard = false;
  for (const part of String(value ?? '').split(',')) {
    const [encoding, ...parameters] = part.trim().toLowerCase().split(';');
    const q = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const quality = !q ? 1 : Number(q.trim().slice(2));
    if (!Number.isFinite(quality) || quality <= 0) {
      if (encoding === 'gzip') return false;
      continue;
    }
    if (encoding === 'gzip') return true;
    if (encoding === '*') wildcard = true;
  }
  return wildcard;
}

function appendVary(res: Response, value: string): void {
  const current = String(res.getHeader('Vary') ?? '');
  const values = current.split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader('Vary', values.join(', '));
}

/**
 * Compress normal JSON responses in-process when the reverse proxy does not
 * provide compression. SSE and file responses are left streaming so a slow
 * client cannot make a compression buffer retain an unbounded connection.
 */
export function compressJsonResponse(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  if (
    req.method === 'HEAD'
    || !acceptsGzip(req.headers['accept-encoding'])
    || path.startsWith('/pics/')
    || path.endsWith('/stream')
    || path.endsWith('.ydk')
  ) {
    next();
    return;
  }

  const writable = res as WritableResponse;
  const originalWrite = writable.write.bind(res);
  const originalEnd = writable.end.bind(res);
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let bypassBuffer = false;
  const pendingCallbacks: Array<(error?: Error | null) => void> = [];
  const chunkSize = (chunk: unknown, encoding?: BufferEncoding): number => {
    if (chunk === undefined || chunk === null || chunk === '') return 0;
    if (Buffer.isBuffer(chunk)) return chunk.length;
    if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
    if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
    return 0;
  };
  const append = (chunk: unknown, encoding?: BufferEncoding): void => {
    if (chunk === undefined || chunk === null || chunk === '') return;
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, encoding));
    } else chunks.push(Buffer.from(chunk as Uint8Array));
    bufferedBytes += chunks[chunks.length - 1].length;
  };
  const flushBuffered = (): void => {
    if (!chunks.length) return;
    const body = Buffer.concat(chunks);
    chunks.length = 0;
    bufferedBytes = 0;
    originalWrite(body);
    for (const callback of pendingCallbacks.splice(0)) callback();
  };
  writable.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), _callback?: (error?: Error | null) => void) => {
    const callback = typeof encoding === 'function' ? encoding : _callback;
    if (bypassBuffer) {
      return originalWrite(chunk as any, typeof encoding === 'string' ? encoding : callback as any);
    }
    if (bufferedBytes + chunkSize(chunk, typeof encoding === 'string' ? encoding : undefined) > MAX_BUFFER_BYTES) {
      bypassBuffer = true;
      flushBuffered();
      return originalWrite(chunk as any, typeof encoding === 'string' ? encoding : callback as any);
    }
    append(chunk, typeof encoding === 'string' ? encoding : undefined);
    if (callback) pendingCallbacks.push(callback);
    if (bufferedBytes > MAX_BUFFER_BYTES) {
      // Do not retain an unbounded response while waiting to discover its
      // content type/size. Flush the already buffered bytes and stream the
      // remainder through the original response methods.
      bypassBuffer = true;
      flushBuffered();
    }
    // The body is intentionally buffered until end; returning true prevents
    // application code from waiting on a socket that we do not write to yet.
    return true;
  }) as WritableResponse['write'];
  writable.end = ((chunk?: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (bypassBuffer) {
      return originalEnd(chunk as any, typeof encoding === 'string' ? encoding : done);
    }
    if (bufferedBytes + chunkSize(chunk, typeof encoding === 'string' ? encoding : undefined) > MAX_BUFFER_BYTES) {
      bypassBuffer = true;
      flushBuffered();
      return originalEnd(chunk as any, typeof encoding === 'string' ? encoding : done);
    }
    append(chunk, typeof encoding === 'string' ? encoding : undefined);
    const contentType = String(res.getHeader('Content-Type') ?? '').toLowerCase();
    const contentEncoding = res.getHeader('Content-Encoding');
    const body = Buffer.concat(chunks);
    // Keep tiny responses and non-JSON downloads untouched. The 2 MiB guard
    // bounds per-request buffering for future large search endpoints.
    const shouldCompress = !contentEncoding
      && body.length >= 512
      && body.length <= MAX_BUFFER_BYTES
      && (contentType.includes('json') || contentType.startsWith('text/'))
      && res.statusCode !== 204
      && res.statusCode !== 304;
    if (!shouldCompress) {
      const result = originalEnd(body.length ? body : undefined, done);
      for (const pending of pendingCallbacks.splice(0)) pending();
      return result;
    }
    gzip(body, { level: 6 }, (error, compressed) => {
      if (error) {
        originalEnd(body.length ? body : undefined, done);
        for (const pending of pendingCallbacks.splice(0)) pending(error);
        return;
      }
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      appendVary(res, 'Accept-Encoding');
      originalEnd(compressed, done);
      for (const pending of pendingCallbacks.splice(0)) pending();
    });
    return res;
  }) as WritableResponse['end'];
  next();
}
