import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClosedRanking, PollDetails } from '../src/domain/types';
import { createFixture } from './helpers/app-fixture';

it('accepts 1000 votes over ~2 seconds in five isolated polls, converges and closes consistently', async () => {
  const f = await createFixture({ rankingThrottleMs: 150 });
  try {
    const polls = await Promise.all(Array.from({ length: 5 }, () => f.create()));
    const streams = await Promise.all(polls.map(poll => f.stream(poll.id)));
    await Promise.all(streams.map(stream => stream.waitFor(frames => frames.length === 1)));
    const started = performance.now();
    const batches: Promise<Awaited<ReturnType<typeof f.vote>>[]>[] = [];
    for (let batch = 0; batch < 20; batch++) {
      if (batch > 0) await delay(Math.max(0, started + batch * 100 - performance.now()));
      batches.push(Promise.all(Array.from({ length: 50 }, (_, i) => {
        const index = batch * 50 + i;
        return f.vote(polls[index % 5]!.id, `vote${index}`, `user${index}`, ['TypeScript', 'Go', 'Rust'][index % 3]!);
      })));
    }
    const responses = (await Promise.all(batches)).flat();
    expect(responses).toHaveLength(1000);
    expect(responses.filter(result => result.status === 202)).toHaveLength(1000);
    expect(responses.filter(result => result.status >= 500)).toHaveLength(0);
    const states = await Promise.all(polls.map(poll => f.request<PollDetails>('GET', `/polls/${poll.id}`)));
    expect(states.reduce((sum, state) => sum + state.body.totalVotes, 0)).toBe(1000);
    for (const [index, state] of states.entries()) {
      expect(state.body.version).toBe(200);
      expect(state.body.totalVotes).toBe(200);
      expect(state.body.ranking.reduce((sum, row) => sum + row.votes, 0)).toBe(200);
      const stream = streams[index]!;
      await stream.waitFor(frames => frames.some(frame => frame.data?.version === 200));
      expect(stream.frames.every(frame => frame.data?.pollId === polls[index]!.id)).toBe(true);
      expect(stream.frames.at(-1)!.data?.ranking).toEqual(state.body.ranking);
      const closed = await f.request<ClosedRanking>('POST', `/polls/${polls[index]!.id}/close`);
      await stream.waitForEnd();
      expect(stream.frames.at(-1)!.data).toEqual(closed.body);
      const get = (await f.request<PollDetails>('GET', `/polls/${polls[index]!.id}`)).body;
      const { title: _title, closesAt: _closesAt, ...common } = get;
      expect(common).toEqual(closed.body);
    }
  } finally { await f.cleanup(); }
}, 10000);
