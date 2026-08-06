import { Injectable } from '@nestjs/common';
import { Response } from 'express';

// SSE hub per tournament (dev_docs/07 §2.3). Clients reconnect and refetch full state.
@Injectable()
export class RealtimeService {
  private clients = new Map<number, Set<Response>>();

  subscribe(tid: number, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let set = this.clients.get(tid);
    if (!set) {
      set = new Set();
      this.clients.set(tid, set);
    }
    set.add(res);
    res.on('close', () => {
      set!.delete(res);
      if (set!.size === 0) this.clients.delete(tid);
    });
  }

  emit(tid: number, event: string, data: any): void {
    const set = this.clients.get(tid);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
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
