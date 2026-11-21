import type { Response } from 'express';
import type { Subscription } from 'rxjs';
import { projectRanking } from '../domain/ranking';
import type { PollEvent, PollState } from '../domain/types';

export function frame(event: PollEvent): string {
  return `id: ${event.data.version}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class SseConnections {
  private readonly active = new Set<() => void>();
  get size(): number { return this.active.size; }

  open(poll: PollState, res: Response): void {
    let ended = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let subscription: Subscription | undefined;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      clearTimeout(heartbeat);
      heartbeat = undefined;
      subscription?.unsubscribe();
      res.off('close', cleanup);
      res.off('error', fail);
      this.active.delete(end);
    };
    const end = () => { cleanup(); if (!res.writableEnded) res.end(); };
    const fail = () => { cleanup(); res.destroy(); };
    const write = (text: string): boolean => {
      if (ended || res.destroyed) { cleanup(); return false; }
      try {
        // Bound per-client buffering: disconnect a client that cannot keep up.
        if (!res.write(text)) { fail(); return false; }
        return true;
      } catch { fail(); return false; }
    };
    const armHeartbeat = () => {
      clearTimeout(heartbeat);
      if (!ended) heartbeat = setTimeout(() => {
        if (write(': heartbeat\n\n')) armHeartbeat();
      }, 15_000);
    };
    const send = (event: PollEvent) => {
      if (!write(frame(event))) return;
      if (event.event === 'closed') end();
      else armHeartbeat();
    };
    res.on('close', cleanup);
    res.on('error', fail);
    this.active.add(end);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try { res.flushHeaders(); } catch { fail(); return; }
    const snapshot = projectRanking(poll);
    if (snapshot.status === 'closed') { send({ event: 'closed', data: snapshot }); return; }
    subscription = poll.runtime.events.subscribe({ next: send, complete: end });
    send({ event: 'ranking', data: snapshot });
  }

  dispose(): void {
    for (const end of [...this.active]) end();
  }
}
