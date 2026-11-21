import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClosedRanking, PollDetails } from '../src/domain/types';
import { createFixture, type Fixture } from './helpers/app-fixture';

describe('parallel requests (RN-01/02/06/09)', () => {
  let f: Fixture;
  beforeEach(async () => { f = await createFixture(); });
  afterEach(async () => { await f?.cleanup(); });

  it('accepts one request for a repeated vote ID without consuming other users quotas', async () => {
    const poll = await f.create();
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => f.vote(poll.id, 'same', `user${i}`)));
    expect(results.filter(result => result.status === 202)).toHaveLength(1);
    expect(results.filter(result => result.status === 200)).toHaveLength(59);
    expect((await f.request('GET', `/polls/${poll.id}`)).body.version).toBe(1);
    const other = await f.create();
    expect((await f.vote(other.id, 'same', 'user0')).status).toBe(202);
  });

  it('never exceeds a user quota under a parallel burst', async () => {
    const poll = await f.create();
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => f.vote(poll.id, `${i}`, 'same')));
    expect(results.filter(result => result.status === 202)).toHaveLength(3);
    expect(results.filter(result => result.status === 409 && result.body.error === 'USER_VOTE_LIMIT')).toHaveLength(57);
    const state = (await f.request<PollDetails>('GET', `/polls/${poll.id}`)).body;
    expect(state.version).toBe(3);
    expect(state.ranking.reduce((sum, row) => sum + row.votes, 0)).toBe(3);
    expect((await f.vote(poll.id, 'another', 'other')).status).toBe(202);
  });

  it('includes every accepted vote when requests race with closing', async () => {
    const poll = await f.create();
    const stream = await f.stream(poll.id);
    await stream.waitFor(frames => frames.length === 1);
    const before = Array.from({ length: 20 }, (_, i) => f.vote(poll.id, `before${i}`, `before${i}`));
    const closing = f.request<ClosedRanking>('POST', `/polls/${poll.id}/close`);
    const after = Array.from({ length: 20 }, (_, i) => f.vote(poll.id, `after${i}`, `after${i}`));
    const results = await Promise.all([...before, ...after]);
    const final = (await closing).body;
    expect(results.every(result => result.status === 202 || (result.status === 409 && result.body.error === 'POLL_CLOSED'))).toBe(true);
    const accepted = results.filter(result => result.status === 202).length;
    expect(final.version).toBe(accepted);
    expect(final.ranking.reduce((sum, row) => sum + row.votes, 0)).toBe(accepted);
    await stream.waitForEnd();
    expect(stream.frames.at(-1)!.data).toEqual(final);
    expect((await f.vote(poll.id, 'last', 'last')).body.error).toBe('POLL_CLOSED');
  });
});
