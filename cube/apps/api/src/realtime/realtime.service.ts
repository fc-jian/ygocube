import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Response } from 'express';

// SSE hub for tournament updates and public room drawing streams.
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private static readonly MAX_CLIENTS_PER_CHANNEL = 128;
  private static readonly MAX_BUFFERED_BYTES = 1024 * 1024;
  private clients = new Map<number | string, Set<Response>>();
  private heartbeat: NodeJS.Timeout | null = null;

  subscribe(channel: number | string, res: Response, snapshot?: unknown): void {
    let set = this.clients.get(channel);
    if ((set?.size ?? 0) >= RealtimeService.MAX_CLIENTS_PER_CHANNEL) {
      res.status(503).json({ ok: false, code: 'STREAM_LIMIT' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(snapshot === undefined ? 'retry: 3000\n\n' : `retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    if (!set) {
      set = new Set();
      this.clients.set(channel, set);
    }
    set.add(res);
    const remove = () => {
      set!.delete(res);
      if (set!.size === 0 && this.clients.get(channel) === set) this.clients.delete(channel);
    };
    res.once('close', remove);
    res.once('error', remove);
    this.ensureHeartbeat();
  }

  emit(channel: number | string, event: string, data: unknown): void {
    const set = this.clients.get(channel);
    if (!set) return;
    let payload: string;
    try {
      payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (error) {
      console.error('SSE serialization failed', channel, event, error);
      return;
    }
    for (const res of set) {
      try {
        if (res.writableEnded || res.destroyed || res.writableLength > RealtimeService.MAX_BUFFERED_BYTES) {
          res.destroy();
          set.delete(res);
          continue;
        }
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
    if (set.size === 0) this.clients.delete(channel);
  }

  close(channel: string): void {
    const set = this.clients.get(channel);
    if (!set) return;
    this.emit(channel, 'closed', null);
    for (const res of set) res.end();
    this.clients.delete(channel);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [channel, set] of this.clients) {
        for (const res of set) {
          try {
            if (res.writableEnded || res.destroyed || res.writableLength > RealtimeService.MAX_BUFFERED_BYTES) {
              res.destroy();
              set.delete(res);
            } else {
              res.write(': keepalive\n\n');
            }
          } catch {
            set.delete(res);
          }
        }
        if (set.size === 0) this.clients.delete(channel);
      }
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    }, 25_000);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const set of this.clients.values()) {
      for (const res of set) res.end();
    }
    this.clients.clear();
  }

  // convenience broadcasters for domain events
  emitPhase(tid: number, status: string, round: number): void {
    this.emit(tid, 'phase', { status, round });
  }
  emitPick(tid: number, data: any): void {
    this.emit(tid, 'pick', data);
  }
  emitPack(tid: number, data: any): void {
    this.emit(tid, 'pack', data);
  }
  emitPause(tid: number, data: any): void {
    this.emit(tid, 'pause', data);
  }
  emitDeck(tid: number, data: any): void {
    this.emit(tid, 'deck', data);
  }
  emitMatch(tid: number, data: any): void {
    this.emit(tid, 'match', data);
  }
  emitNotice(tid: number, text: string): void {
    this.emit(tid, 'notice', { text });
  }
}
