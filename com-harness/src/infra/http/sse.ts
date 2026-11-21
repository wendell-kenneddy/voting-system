import type { Request, Response } from 'express';
import type { PollStream, StreamEvent } from '../../application/pollRuntime';

const encodedEvents = new WeakMap<StreamEvent, string>();

function encode(event: StreamEvent): string {
  if (event.kind === 'heartbeat') return ': heartbeat\n\n';

  const { ranking } = event;
  let frame = encodedEvents.get(event);
  if (frame === undefined) {
    frame = `id: ${ranking.version}\nevent: ${event.kind}\ndata: ${JSON.stringify(ranking)}\n\n`;
    encodedEvents.set(event, frame);
  }
  return frame;
}

export function sendStream(req: Request, res: Response, events: PollStream): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });

  let cleaned = false;
  let unsubscribe: (() => void) | undefined;
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    req.off('close', onRequestClose);
    res.off('close', cleanup);
    res.off('error', abort);
    unsubscribe?.();
  }
  function abort(): void {
    cleanup();
    if (!res.destroyed) res.destroy();
  }
  function onRequestClose(): void {
    if (!req.complete || req.socket.destroyed) abort();
  }

  req.once('close', onRequestClose);
  res.once('close', cleanup);
  res.once('error', abort);
  const subscription = events.subscribe({
    next: event => {
      if (res.writableEnded || res.destroyed) return;
      try {
        const frame = encode(event);
        if (event.kind === 'closed') {
          res.end(frame);
        } else {
          res.write(frame);
        }
      } catch {
        abort();
      }
    },
    error: abort,
    complete: () => {
      if (!res.writableEnded && !res.destroyed) res.end();
      cleanup();
    },
  });
  unsubscribe = () => subscription.unsubscribe();
  if (cleaned) unsubscribe();
}
