import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollDetails } from '../src/domain/types';
import { createFixture, type Fixture } from './helpers/app-fixture';
import { voteBody } from './helpers/builders';

describe('JSON HTTP contracts', () => {
  let f: Fixture;
  beforeEach(async () => { f = await createFixture({ rankingThrottleMs: 10000 }); });
  afterEach(async () => { await f?.cleanup(); });

  it('health, creation, metadata and immediate GET during throttle', async () => {
    expect((await f.request('GET', '/health')).body).toEqual({ status: 'ok' });
    const poll = await f.create({ title: ' Title ', options: ['A', 'a', ' A ', '__proto__'], extra: true });
    expect(Object.keys(poll).sort()).toEqual(['closesAt', 'id', 'options', 'status', 'title']);
    expect(poll).toMatchObject({ title: ' Title ', status: 'open', closesAt: null, options: ['A', 'a', ' A ', '__proto__'] });
    const initial = await f.request<PollDetails>('GET', `/polls/${poll.id}`);
    expect(initial.status).toBe(200);
    expect(initial.headers['content-type']).toContain('application/json');
    expect(initial.body).toMatchObject({ pollId: poll.id, title: ' Title ', version: 0, totalVotes: 0, closedAt: null });
    expect(new Date(initial.body.updatedAt).toISOString()).toBe(initial.body.updatedAt);
    expect(initial.body.ranking.map(row => row.option)).toEqual(poll.options);
    for (const [index, option] of ['a', 'A', ' A '].entries()) {
      expect((await f.vote(poll.id, `${index}`, '__proto__', option)).status).toBe(202);
      const get = await f.request<PollDetails>('GET', `/polls/${poll.id}`);
      expect(get.body.version).toBe(index + 1);
      expect(get.body.totalVotes).toBe(index + 1);
      expect(get.body.ranking.reduce((sum, row) => sum + row.votes, 0)).toBe(index + 1);
    }
    const final = (await f.request<PollDetails>('GET', `/polls/${poll.id}`)).body;
    expect(final.ranking.map(row => row.option)).toEqual(poll.options);
    const timed = await f.create({ durationSeconds: 86400 });
    expect(Date.parse(timed.closesAt!)).toBeGreaterThan(Date.now());
  });

  it.each(['null', '[]', '"text"', '42', 'true', '{', '', '{}'])('returns route-specific JSON errors for raw body %s', async raw => {
    const poll = await f.create();
    for (const [path, code] of [['/polls', 'INVALID_POLL'], [`/polls/${poll.id}/votes`, 'INVALID_VOTE']]) {
      const result = await f.request('POST', path!, raw, true);
      expect(result.status).toBe(400);
      expect(result.headers['content-type']).toContain('application/json');
      expect(result.body).toEqual({ error: code, message: expect.any(String) });
    }
  });

  it('handles missing bodies, non-JSON and oversized bodies through the same envelope', async () => {
    const poll = await f.create();
    for (const [path, code] of [['/polls', 'INVALID_POLL'], [`/polls/${poll.id}/votes`, 'INVALID_VOTE']]) {
      for (const [body, raw, contentType] of [
        [undefined, false, 'application/json'], ['{}', true, 'text/plain'], [' '.repeat(1024 * 1024 + 1), true, 'application/json'],
      ] as const) {
        const result = await f.request('POST', path!, body, raw, contentType);
        expect(result.status).toBe(400);
        expect(result.body.error).toBe(code);
      }
    }
  });

  it('looks up polls before body parsing for votes and uses JSON 404 on all poll routes', async () => {
    for (const body of ['{', 'null', JSON.stringify(voteBody())]) {
      const result = await f.request('POST', '/polls/missing/votes', body, true);
      expect(result.status).toBe(404);
      expect(result.body.error).toBe('POLL_NOT_FOUND');
    }
    for (const [method, path] of [['GET', '/polls/missing'], ['GET', '/polls/missing/stream'], ['POST', '/polls/missing/close']]) {
      const result = await f.request(method!, path!);
      expect(result.status).toBe(404);
      expect(result.headers['content-type']).toContain('application/json');
      expect(result.body).toEqual({ error: 'POLL_NOT_FOUND', message: expect.any(String) });
    }
  });

  it('preserves complete error precedence and idempotence (RN-01/02/09)', async () => {
    const poll = await f.create();
    const path = `/polls/${poll.id}/votes`;
    expect((await f.vote(poll.id)).body).toEqual({ status: 'accepted', voteId: 'v1' });
    const original = (await f.request('GET', `/polls/${poll.id}`)).body;
    const duplicate = await f.vote(poll.id, 'v1', 'other', 'Go');
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ status: 'duplicate', voteId: 'v1' });
    expect((await f.request('GET', `/polls/${poll.id}`)).body).toEqual(original);
    expect((await f.request('POST', path, { ...voteBody(), userId: null })).body.error).toBe('INVALID_VOTE');
    for (const option of ['unknown', 'x'.repeat(101)]) {
      const response = await f.vote(poll.id, 'v1', 'u1', option);
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('UNKNOWN_OPTION');
    }
    expect((await f.vote(poll.id, 'v2')).status).toBe(202);
    expect((await f.vote(poll.id, 'v3')).status).toBe(202);
    expect((await f.vote(poll.id, 'v4')).body.error).toBe('USER_VOTE_LIMIT');
    expect((await f.vote(poll.id)).status).toBe(200);
    const closed = await f.request('POST', `/polls/${poll.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', version: 3, closedAt: closed.body.updatedAt });
    expect((await f.request('POST', `/polls/${poll.id}/close`)).body).toEqual(closed.body);
    expect((await f.request('POST', path, {})).body.error).toBe('INVALID_VOTE');
    expect((await f.request('POST', path, '{', true)).body.error).toBe('INVALID_VOTE');
    for (const option of ['TypeScript', 'unknown']) {
      const result = await f.vote(poll.id, 'v1', 'u1', option);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('POLL_CLOSED');
    }
  });

  it('isolates unexpected request failures from subsequent processing (RN-07)', async () => {
    const poll = await f.create();
    const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    const spy = vi.spyOn(f.service, 'vote').mockImplementationOnce(() => { throw new Error('private stack'); });
    const failed = await f.vote(poll.id);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'INTERNAL_ERROR', message: expect.any(String) });
    expect(JSON.stringify(failed.body)).not.toContain('private stack');
    spy.mockRestore();
    expect((await f.vote(poll.id)).status).toBe(202);
    await stream.waitFor(frames => frames.some(frame => frame.data?.version === 1));
    expect(stream.ended).toBe(false);
  });
});
