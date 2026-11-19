import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Response } from 'express';

// SSE hub per tournament (dev_docs/07 §2.3). Clients reconnect and refetch full state.
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private static readonly MAX_CLIENTS_PER_TOURNAMENT = 128;
  private static readonly MAX_BUFFERED_BYTES = 1024 * 1024;
  private clients = new Map<number, Set<Response>>();
  private heartbeat: NodeJS.Timeout | null = null;

  subscribe(tid: number, res: Response): void {
    let set = this.clients.get(tid);
    if ((set?.size ?? 0) >= RealtimeService.MAX_CLIENTS_PER_TOURNAMENT) {
      res.status(503).json({ ok: false, code: 'STREAM_LIMIT' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    if (!set) {
      set = new Set();
      this.clients.set(tid, set);
    }
    set.add(res);
    const remove = () => {
      set!.delete(res);
      if (set!.size === 0) this.clients.delete(tid);
    };
    res.once('close', remove);
    res.once('error', remove);
    this.ensureHeartbeat();
  }

  emit(tid: number, event: string, data: any): void {
    const set = this.clients.get(tid);
    if (!set) return;
    let payload: string;
    try {
      payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (error) {
      console.error('SSE serialization failed', tid, event, error);
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
    if (set.size === 0) this.clients.delete(tid);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [tid, set] of this.clients) {
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
        if (set.size === 0) this.clients.delete(tid);
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
