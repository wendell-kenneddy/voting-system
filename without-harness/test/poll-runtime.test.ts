import { afterEach, describe, expect, it } from 'vitest';
import { VirtualTimeScheduler } from 'rxjs';
import { createApp } from '../src/app';
import type { PollEvent } from '../src/domain/types';
import { pollBody, voteBody } from './helpers/builders';

describe('shared RxJS runtime', () => {
  const applications: ReturnType<typeof createApp>[] = [];
  afterEach(() => { for (const app of applications.splice(0)) app.dispose(); });
  function setup(interval = 100) {
    const scheduler = new VirtualTimeScheduler();
    const app = createApp({ port: 3000, maxVotesPerUser: 100, rankingThrottleMs: interval }, { scheduler, now: () => scheduler.now() });
    applications.push(app);
    const poll = app.service.create(pollBody());
    const runtime = app.store.get(poll.id).runtime;
    const events: { at: number; event: PollEvent }[] = [];
    runtime.events.subscribe(event => events.push({ at: scheduler.now(), event }));
    const advance = (at: number) => {
      scheduler.maxFrames = at;
      scheduler.flush();
      scheduler.frame = at;
    };
    const vote = (id: string) => app.service.vote(poll.id, voteBody(id));
    return { ...app, scheduler, poll, runtime, events, advance, vote };
  }

  it('coalesces outside vote stack, leading/trailing, fresh trailing window and silence (RN-04/05)', () => {
    const f = setup();
    f.vote('1'); f.vote('2');
    expect(f.events).toEqual([]);
    expect(f.runtime.resources).toMatchObject({ pipeline: 1, publication: 1 });
    f.advance(0);
    expect(f.events.map(x => [x.at, x.event.data.version])).toEqual([[0, 2]]);
    f.advance(10); f.vote('3'); f.advance(20); f.vote('4');
    f.advance(99); expect(f.events).toHaveLength(1);
    f.advance(100); expect(f.events.at(-1)?.event.data.version).toBe(4);
    f.advance(110); f.vote('5'); f.advance(199); expect(f.events).toHaveLength(2);
    f.advance(200); expect(f.events.map(x => x.at)).toEqual([0, 100, 200]);
    f.advance(5000); expect(f.events).toHaveLength(3);
    f.vote('6'); f.advance(5000); expect(f.events.at(-1)?.at).toBe(5000);
    expect(f.events[0]?.event.data.version).toBe(2);
  });

  it('zero throttle publishes the latest state without loss', () => {
    const f = setup(0);
    f.vote('1'); f.vote('2'); f.advance(0);
    f.advance(1); f.vote('3'); f.advance(1);
    expect(f.events.map(x => x.event.data.version)).toEqual([2, 3]);
  });

  it('does not renew the throttle for a boundary vote already included in the trailing snapshot (RN-04)', () => {
    const f = setup(1000);
    // Register this vote before the throttle timer so it runs first at the boundary.
    f.scheduler.schedule(() => f.vote('3'), 1000);
    f.vote('1'); f.advance(0);
    f.advance(100); f.vote('2'); f.advance(100);
    f.advance(1000);
    expect(f.events.map(x => [x.at, x.event.data.version])).toEqual([[0, 1], [1000, 3]]);

    f.advance(2100);
    f.vote('4');
    expect(f.events).toHaveLength(2);
    f.advance(2100);
    expect(f.events.map(x => [x.at, x.event.data.version])).toEqual([[0, 1], [1000, 3], [2100, 4]]);
    f.advance(5000);
    expect(f.events).toHaveLength(3);
  });

  it('new subscriptions do not consume or restart windows; polls are isolated (RN-03/05)', () => {
    const f = setup();
    const other = f.service.create(pollBody());
    const otherEvents: PollEvent[] = [];
    f.store.get(other.id).runtime.events.subscribe(event => otherEvents.push(event));
    f.vote('1'); f.advance(0);
    f.advance(30); f.vote('2'); f.advance(30);
    const newcomer: PollEvent[] = [];
    f.runtime.events.subscribe(event => newcomer.push(event));
    expect(newcomer).toEqual([]);
    f.advance(100);
    expect(newcomer.map(x => x.data.version)).toEqual([2]);
    expect(otherEvents).toEqual([]);
    f.service.close(f.poll.id);
    expect(otherEvents).toEqual([]);
    expect(f.store.get(other.id).runtime.resources.pipeline).toBe(1);
  });

  it('close cancels pending publications, trailing and automatic timer (RN-10/11)', () => {
    const f = setup(10000);
    const timed = f.service.create(pollBody({ durationSeconds: 2 }));
    const runtime = f.store.get(timed.id).runtime;
    const events: PollEvent[] = [];
    runtime.events.subscribe(event => events.push(event));
    f.service.vote(timed.id, voteBody('1')); f.advance(0);
    f.advance(10); f.service.vote(timed.id, voteBody('2')); f.advance(10);
    f.service.vote(timed.id, voteBody('3'));
    const final = f.service.close(timed.id);
    expect(final.version).toBe(3);
    expect(events.map(x => x.event)).toEqual(['ranking', 'closed']);
    expect(events.at(-1)?.data).toEqual(final);
    expect(runtime.resources).toEqual({ pipeline: 0, publication: 0, deadline: 0, subscribers: 0 });
    f.advance(20000);
    expect(events).toHaveLength(2);
    expect(f.service.close(timed.id)).toEqual(final);
  });

  it('automatic close and application disposal release all owned scheduling (RN-09/11)', () => {
    const f = setup();
    const timed = f.service.create(pollBody({ durationSeconds: 1 }));
    const runtime = f.store.get(timed.id).runtime;
    f.advance(999); expect(f.service.details(timed.id).status).toBe('open');
    f.advance(1000); expect(f.service.details(timed.id).status).toBe('closed');
    expect(runtime.resources.deadline).toBe(0);
    f.vote('pending'); f.dispose();
    expect(f.store.polls.size).toBe(0);
    expect(f.runtime.resources).toEqual({ pipeline: 0, publication: 0, deadline: 0, subscribers: 0 });
    expect(f.scheduler.actions).toHaveLength(0);
  });
});
