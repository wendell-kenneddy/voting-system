import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClosedRanking, PollDetails } from '../src/domain/types';
import { createFixture, type Fixture } from './helpers/app-fixture';
import { SseClient } from './helpers/sse-client';

describe('SSE over real HTTP', () => {
  let f: Fixture | undefined;
  afterEach(async () => { await f?.cleanup(); });

  it('parses partial frames, multiple frames, comments and JSON strings', () => {
    const client = new SseClient();
    client.ingest('id: 0\neve');
    client.ingest('nt: ranking\ndata: {"version":0,"option":"ação"}\n');
    expect(client.frames).toHaveLength(0);
    client.ingest('\n: heartbeat\n\nid: 1\nevent: closed\ndata: {"version":1}\n\n');
    expect(client.frames.map(frame => frame.event ?? frame.comment)).toEqual(['ranking', 'heartbeat', 'closed']);
    expect(client.frames[0]?.id).toBe('0');
  });

  it('delivers initial snapshots, shared leading/trailing and independent newcomer snapshots (RN-04/05)', async () => {
    f = await createFixture({ rankingThrottleMs: 500 });
    const poll = await f.create();
    const started = performance.now();
    const a = await f.stream(poll.id);
    const b = await f.stream(poll.id);
    await Promise.all([a.waitFor(frames => frames.length === 1), b.waitFor(frames => frames.length === 1)]);
    expect(a.frames[0]!.at - started).toBeLessThanOrEqual(500);
    expect(a.headers['content-type']).toContain('text/event-stream');
    expect(a.headers['cache-control']).toBe('no-cache');
    expect(a.frames[0]!.data?.ranking).toHaveLength(3);
    expect(a.frames[0]!.data?.ranking.every(row => row.votes === 0)).toBe(true);
    expect(Object.keys(a.frames[0]!.data!).sort()).toEqual(['pollId', 'ranking', 'status', 'totalVotes', 'updatedAt', 'version']);
    const firstVoteAt = performance.now();
    await f.vote(poll.id, '1');
    await Promise.all([a.waitFor(frames => frames.length === 2), b.waitFor(frames => frames.length === 2)]);
    expect(a.frames[1]!.at - firstVoteAt).toBeLessThanOrEqual(300);
    await f.vote(poll.id, '2');
    await f.vote(poll.id, '3');
    const newcomerAt = performance.now();
    const c = await f.stream(poll.id);
    await c.waitFor(frames => frames.length >= 1);
    expect(c.frames[0]!.at - newcomerAt).toBeLessThanOrEqual(500);
    expect(c.frames[0]!.data?.version).toBe(3);
    expect(a.frames).toHaveLength(2);
    await Promise.all([a.waitFor(frames => frames.length === 3), b.waitFor(frames => frames.length === 3), c.waitFor(frames => frames.length === 2)]);
    expect(a.frames[2]!.at - a.frames[1]!.at).toBeGreaterThanOrEqual(400);
    expect(a.frames[2]!.data?.version).toBe(3);
    expect(a.frames.map(({ id, event, data }) => ({ id, event, data }))).toEqual(b.frames.map(({ id, event, data }) => ({ id, event, data })));
    expect(c.frames[1]!.data).toEqual(a.frames[2]!.data);
    for (const frame of a.frames) expect(frame.id).toBe(String(frame.data?.version));
    // Observe a full extra window: neither time, duplicates nor rejections create events.
    await f.vote(poll.id, '3');
    await f.vote(poll.id, '4');
    await delay(550);
    expect(a.frames).toHaveLength(3);
  });

  it('bypasses throttle at close, includes pending votes and ends once within limits (RN-09/10/11)', async () => {
    f = await createFixture({ rankingThrottleMs: 10000 });
    const poll = await f.create({ durationSeconds: 60 });
    const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    await f.vote(poll.id, '1');
    await stream.waitFor(frames => frames.length === 2);
    await f.vote(poll.id, '2');
    const at = performance.now();
    const closed = await f.request<ClosedRanking>('POST', `/polls/${poll.id}/close`);
    await stream.waitForEnd(500);
    expect(stream.frames.at(-1)!.at - at).toBeLessThanOrEqual(500);
    expect(performance.now() - at).toBeLessThanOrEqual(500);
    expect(stream.frames.map(frame => frame.event)).toEqual(['ranking', 'ranking', 'closed']);
    expect(stream.frames.at(-1)!.data).toEqual(closed.body);
    expect(closed.body.version).toBe(2);
    expect(closed.body.updatedAt).toBe(closed.body.closedAt);
    const get = await f.request<PollDetails>('GET', `/polls/${poll.id}`);
    const { title: _title, closesAt: _deadline, ...common } = get.body;
    expect(common).toEqual(closed.body);
    const lateAt = performance.now();
    const late = await f.stream(poll.id);
    await late.waitForEnd(500);
    expect(late.frames).toHaveLength(1);
    expect(late.frames[0]!.event).toBe('closed');
    expect(late.frames[0]!.data).toEqual(closed.body);
    expect(late.frames[0]!.at - lateAt).toBeLessThanOrEqual(500);
    expect(f.connections.size).toBe(0);
    expect(f.store.get(poll.id).runtime.resources).toEqual({ pipeline: 0, publication: 0, deadline: 0, subscribers: 0 });
  });

  it('closes automatically within deadline tolerance with pending trailing and EOF', async () => {
    f = await createFixture({ rankingThrottleMs: 10000 });
    const beforeCreate = performance.now();
    const poll = await f.create({ durationSeconds: 1 });
    const planned = performance.now() + Date.parse(poll.closesAt!) - Date.now();
    const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    await f.vote(poll.id, '1');
    await stream.waitFor(frames => frames.length === 2);
    await f.vote(poll.id, '2');
    await stream.waitForEnd(1500);
    const closed = stream.frames.at(-1)!;
    expect(closed.event).toBe('closed');
    expect(closed.data?.version).toBe(2);
    expect(closed.at - planned).toBeGreaterThanOrEqual(-30);
    expect(closed.at - planned).toBeLessThanOrEqual(500);
    expect(performance.now() - planned).toBeLessThanOrEqual(500);
    expect(closed.at - beforeCreate).toBeGreaterThanOrEqual(950);
    expect((await f.vote(poll.id, '3')).body.error).toBe('POLL_CLOSED');
    expect(f.store.get(poll.id).runtime.resources.deadline).toBe(0);
  });

  it('keeps streams healthy after rejected requests and isolates polls (RN-03/07)', async () => {
    f = await createFixture({ maxVotesPerUser: 1, rankingThrottleMs: 0 });
    const a = await f.create(); const b = await f.create();
    const streamA = await f.stream(a.id); const streamB = await f.stream(b.id);
    await Promise.all([streamA.waitFor(frames => frames.length === 1), streamB.waitFor(frames => frames.length === 1)]);
    await f.vote(a.id);
    await streamA.waitFor(frames => frames.length === 2);
    for (const body of [{}, '{']) await f.request('POST', `/polls/${a.id}/votes`, body, typeof body === 'string');
    expect((await f.vote(a.id, '2', 'u2', 'unknown')).status).toBe(422);
    expect((await f.vote(a.id)).status).toBe(200);
    expect((await f.vote(a.id, '2')).status).toBe(409);
    expect((await f.vote(a.id, '2', 'u2')).status).toBe(202);
    await streamA.waitFor(frames => frames.some(frame => frame.data?.version === 2));
    await f.request('POST', `/polls/${a.id}/close`);
    await streamA.waitForEnd();
    expect(streamB.frames).toHaveLength(1);
    expect(streamB.ended).toBe(false);
    await f.vote(b.id);
    await streamB.waitFor(frames => frames.some(frame => frame.data?.version === 1));
  });

  it('zero-vote close emits the full final ranking', async () => {
    f = await createFixture();
    const poll = await f.create(); const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    await f.request('POST', `/polls/${poll.id}/close`);
    await stream.waitForEnd();
    expect(stream.frames.map(frame => frame.event)).toEqual(['ranking', 'closed']);
    expect(stream.frames[1]!.id).toBe('0');
    expect(stream.frames[1]!.data?.ranking.every(row => row.votes === 0)).toBe(true);
  });

  it('sends the exact heartbeat comment after 15 seconds without altering business state', async () => {
    f = await createFixture();
    const poll = await f.create(); const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    const original = (await f.request('GET', `/polls/${poll.id}`)).body;
    await stream.waitFor(frames => frames.some(frame => frame.comment === 'heartbeat'), 16500);
    expect(stream.frames.map(frame => frame.event ?? frame.comment)).toEqual(['ranking', 'heartbeat']);
    const heartbeat = stream.frames[1]!;
    expect(heartbeat.at - stream.frames[0]!.at).toBeGreaterThanOrEqual(14900);
    expect(heartbeat.id).toBeUndefined(); expect(heartbeat.data).toBeUndefined();
    expect((await f.request('GET', `/polls/${poll.id}`)).body).toEqual(original);
  }, 18000);
});
