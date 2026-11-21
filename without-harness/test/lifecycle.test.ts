import { EventEmitter, once } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { SseConnections } from '../src/http/sse';
import { startServer } from '../src/server';
import { createFixture } from './helpers/app-fixture';
import { pollBody, voteBody } from './helpers/builders';
import { SseClient } from './helpers/sse-client';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';

class MemoryResponse extends EventEmitter {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  failWrite = false;
  status() { return this; }
  set() { return this; }
  flushHeaders() {}
  write(text: string) {
    if (this.failWrite) throw new Error('disconnected socket');
    this.chunks.push(text);
    return true;
  }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  asResponse() { return this as unknown as Response; }
}

describe('SSE timers and resources', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resets a single idle timer on activity and emits exact comments, with no cadence changes', () => {
    vi.useFakeTimers();
    const app = createApp({ port: 3000, maxVotesPerUser: 3, rankingThrottleMs: 1000 });
    try {
      const created = app.service.create(pollBody());
      const poll = app.store.get(created.id);
      const response = new MemoryResponse();
      app.connections.open(poll, response.asResponse());
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(14000);
      expect(response.chunks).toHaveLength(1);
      app.service.vote(poll.id, voteBody());
      vi.advanceTimersByTime(0);
      expect(response.chunks).toHaveLength(2);
      vi.advanceTimersByTime(14999);
      expect(response.chunks).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(response.chunks.at(-1)).toBe(': heartbeat\n\n');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(15000);
      expect(response.chunks.filter(chunk => chunk === ': heartbeat\n\n')).toHaveLength(2);
      const final = app.service.close(poll.id);
      expect(final.version).toBe(1);
      expect(response.writableEnded).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
      expect(response.listenerCount('error')).toBe(0);
      expect(app.connections.size).toBe(0);
    } finally { app.dispose(); }
  });

  it('isolates failed clients and has no SSE writes in the vote call stack (RN-05/07/08)', () => {
    vi.useFakeTimers();
    const app = createApp({ port: 3000, maxVotesPerUser: 3, rankingThrottleMs: 0 });
    try {
      const created = app.service.create(pollBody());
      const poll = app.store.get(created.id);
      const a = new MemoryResponse(); const b = new MemoryResponse();
      const connections = new SseConnections();
      connections.open(poll, a.asResponse()); connections.open(poll, b.asResponse());
      a.failWrite = true;
      expect(poll.runtime.resources.subscribers).toBe(2);
      app.service.vote(poll.id, voteBody());
      expect(a.chunks).toHaveLength(1); expect(b.chunks).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(a.destroyed).toBe(true);
      expect(b.chunks).toHaveLength(2);
      expect(connections.size).toBe(1);
      expect(poll.runtime.resources.subscribers).toBe(1);
      app.service.vote(poll.id, voteBody('2'));
      vi.advanceTimersByTime(1);
      expect(b.chunks).toHaveLength(3);
      connections.dispose();
      expect(connections.size).toBe(0);
      expect(poll.runtime.resources.subscribers).toBe(0);
    } finally { app.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('real connection lifecycle', () => {
  it('releases disconnected clients repeatedly without affecting the remaining stream (RN-08)', async () => {
    const f = await createFixture({ rankingThrottleMs: 0 });
    try {
      const poll = await f.create();
      const runtime = f.store.get(poll.id).runtime;
      const survivor = await f.stream(poll.id);
      await survivor.waitFor(frames => frames.length === 1);
      for (let i = 0; i < 8; i++) {
        const transient = await f.stream(poll.id);
        await transient.waitFor(frames => frames.length === 1);
        expect(f.connections.size).toBe(2);
        transient.close();
        await expect.poll(() => f.connections.size, { timeout: 1000 }).toBe(1);
        expect(runtime.resources.subscribers).toBe(1);
      }
      await f.vote(poll.id);
      await survivor.waitFor(frames => frames.some(frame => frame.data?.version === 1));
      expect(survivor.ended).toBe(false);
    } finally { await f.cleanup(); }
  });

  it('disposes active clients, open polls, future deadlines and is idempotent', async () => {
    const f = await createFixture();
    try {
      const poll = await f.create({ durationSeconds: 86400 });
      const state = f.store.get(poll.id);
      const stream = await f.stream(poll.id);
      await stream.waitFor(frames => frames.length === 1);
      await f.vote(poll.id);
      f.dispose(); f.dispose();
      await stream.waitForEnd();
      expect(f.connections.size).toBe(0);
      expect(f.store.polls.size).toBe(0);
      expect(state.runtime.resources).toEqual({ pipeline: 0, publication: 0, deadline: 0, subscribers: 0 });
    } finally { await f.cleanup(); }
  });

  it('server shutdown closes active streams and pending timers and returns the same promise', async () => {
    const instance = startServer({ port: 0, maxVotesPerUser: 3, rankingThrottleMs: 10000 });
    const stream = new SseClient();
    try {
      await once(instance.server, 'listening');
      const poll = instance.service.create(pollBody({ durationSeconds: 86400 }));
      const port = (instance.server.address() as AddressInfo).port;
      await stream.connect(`http://127.0.0.1:${port}/polls/${poll.id}/stream`);
      await stream.waitFor(frames => frames.length === 1);
      instance.service.vote(poll.id, voteBody());
      const first = instance.stop();
      expect(instance.stop()).toBe(first);
      await first;
      await stream.waitForEnd();
      expect(instance.server.listening).toBe(false);
      expect(instance.store.polls.size).toBe(0);
    } finally { stream.close(); await instance.stop(); }
  });

  it('does not create resources when a body finishes arriving during shutdown', async () => {
    const f = await createFixture();
    const payload = JSON.stringify(pollBody({ durationSeconds: 86400 }));
    const arrived = once(f.server, 'request');
    const req = request(`${f.url}/polls`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } });
    req.setTimeout(3000, () => req.destroy(new Error('Shutdown request timeout')));
    const response = new Promise<{ status: number; body: { error: string } }>((resolve, reject) => {
      req.on('error', reject);
      req.on('response', res => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) as { error: string } }));
      });
    });
    try {
      req.write(payload.slice(0, 10));
      await arrived;
      const stopping = f.cleanup();
      req.end(payload.slice(10));
      expect(await response).toMatchObject({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });
      await stopping;
      expect(f.store.polls.size).toBe(0);
      expect(() => f.service.create(pollBody())).toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }));
    } finally {
      req.destroy();
      if (f.server.listening) await f.cleanup();
    }
  });
});
