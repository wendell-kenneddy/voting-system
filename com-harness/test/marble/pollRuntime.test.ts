import { map, queueScheduler, type SchedulerAction, type SchedulerLike, type Subscription } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it } from 'vitest';
import { PollRegistry } from '../../src/application/pollRegistry';
import type { StreamEvent } from '../../src/application/pollRuntime';
import type { Result } from '../../src/domain/errors';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function iso(time: number): string {
  const seconds = String(Math.trunc(time / 1000)).padStart(2, '0');
  const millis = String(time % 1000).padStart(3, '0');
  return `2026-11-20T15:00:${seconds}.${millis}Z`;
}

function createRegistry(scheduler: SchedulerLike, rankingThrottleMs = 10) {
  let id = 0;
  return new PollRegistry({
    scheduler, clock: { now: () => scheduler.now(), toIso: iso },
    ids: { next: () => String(id++) }, maxVotesPerUser: 3, rankingThrottleMs,
  });
}

function trace(event: StreamEvent): string {
  return event.kind === 'heartbeat' ? 'heartbeat' : `${event.kind}:${event.ranking.version}`;
}

function makePoll(registry: PollRegistry, durationSeconds?: number) {
  const { id } = value(registry.create({ title: 'Linguagens', options: ['A', 'B'], durationSeconds }));
  return {
    id,
    vote: (n: number) => value(registry.vote(id, { voteId: `v${n}`, userId: `u${n}`, option: 'A' })),
    events: () => value(registry.stream(id)),
    close: () => value(registry.close(id)),
  };
}

function time() {
  return new TestScheduler((actual: unknown, expected: unknown) => expect(actual).toEqual(expected));
}

describe('cadência por enquete', () => {
  it('emite leading, mantém o último trailing e abre a janela a partir de cada emissão', () => {
    const scheduler = time();
    scheduler.run(({ expectObservable }) => {
      const registry = createRegistry(scheduler);
      const poll = makePoll(registry);
      const first = poll.events().pipe(map(trace));
      const second = poll.events().pipe(map(trace));
      [[2, 1], [4, 2], [6, 3], [13, 4], [40, 5]].forEach(([frame, vote]) => {
        scheduler.schedule(() => poll.vote(vote), frame);
      });
      scheduler.schedule(() => expect(value(registry.get(poll.id)).version).toBe(3), 7);
      scheduler.schedule(() => poll.close(), 55);

      const values = { s: 'ranking:0', a: 'ranking:1', c: 'ranking:3', d: 'ranking:4', e: 'ranking:5', x: 'closed:5' };
      expectObservable(first).toBe('s 1ms a 9ms c 9ms d 17ms e 14ms (x|)', values);
      expectObservable(second).toBe('s 1ms a 9ms c 9ms d 17ms e 14ms (x|)', values);
    });
  });

  it('preserva a janela na ausência de clientes e o snapshot reflete votos retidos', () => {
    const scheduler = time();
    scheduler.run(({ expectObservable }) => {
      const poll = makePoll(createRegistry(scheduler));
      scheduler.schedule(() => poll.vote(1), 1);
      scheduler.schedule(() => poll.vote(2), 5);
      scheduler.schedule(() => poll.vote(3), 7);
      scheduler.schedule(() => poll.close(), 20);
      const values = { s: 'ranking:0', a: 'ranking:1', b: 'ranking:2', c: 'ranking:3', x: 'closed:3' };
      expectObservable(poll.events().pipe(map(trace)), '^ 2ms !').toBe('sa', values);
      expectObservable(poll.events().pipe(map(trace)), '6ms ^').toBe('6ms b 4ms c 8ms (x|)', values);
    });
  });

  it('reutiliza o objeto materializado e emite cada voto síncrono com throttle zero', () => {
    const poll = makePoll(createRegistry({ now: () => 0, schedule: queueScheduler.schedule.bind(queueScheduler) }, 0));
    const first: StreamEvent[] = [];
    const second: StreamEvent[] = [];
    const firstSub = poll.events().subscribe({ next: event => first.push(event), error: error => { throw error; } });
    const secondSub = poll.events().subscribe({ next: event => second.push(event), error: error => { throw error; } });
    try {
      poll.vote(1);
      poll.vote(1);
      poll.vote(2);
      poll.vote(3);
      poll.close();
      expect(first.map(trace)).toEqual(['ranking:0', 'ranking:1', 'ranking:2', 'ranking:3', 'closed:3']);
      expect(second.map(trace)).toEqual(first.map(trace));
      for (const index of [1, 2, 3, 4]) expect(second[index]).toBe(first[index]);
    } finally {
      firstSub.unsubscribe();
      secondSub.unsubscribe();
    }
  });
});

describe('encerramento e heartbeat', () => {
  it('cancela o trailing e o prazo automático ao fechar manualmente', () => {
    const scheduler = time();
    const pending = new Set<Subscription>();
    const tracked: SchedulerLike = {
      now: () => scheduler.now(),
      schedule<T>(work: (this: SchedulerAction<T>, state?: T) => void, delay?: number, state?: T) {
        const action = scheduler.schedule(work, delay, state);
        pending.add(action);
        action.add(() => { pending.delete(action); });
        return action;
      },
    };
    scheduler.run(({ expectObservable }) => {
      const poll = makePoll(createRegistry(tracked, 500), 1);
      scheduler.schedule(() => poll.vote(1), 1);
      scheduler.schedule(() => poll.vote(2), 2);
      scheduler.schedule(() => expect(pending.size).toBe(3), 3);
      scheduler.schedule(() => {
        expect(poll.close()).toMatchObject({ version: 2, totalVotes: 2, closedAt: iso(4), updatedAt: iso(4) });
        expect(pending.size).toBe(0);
      }, 4);
      scheduler.schedule(() => expect(poll.close().closedAt).toBe(iso(4)), 1001);
      expectObservable(poll.events().pipe(map(trace))).toBe('sa 2ms (x|)', {
        s: 'ranking:0', a: 'ranking:1', x: 'closed:2',
      });
    });
  });

  it('encerra automaticamente e retorna apenas closed a um cliente posterior', () => {
    const scheduler = time();
    scheduler.run(({ expectObservable }) => {
      const registry = createRegistry(scheduler);
      const poll = makePoll(registry, 1);
      scheduler.schedule(() => {
        expect(value(registry.get(poll.id))).toMatchObject({ closesAt: iso(1000), closedAt: iso(1000) });
        expect(registry.vote(poll.id, { voteId: 'late', userId: 'u', option: 'A' }))
          .toMatchObject({ error: 'POLL_CLOSED' });
      }, 1001);
      const values = { s: 'ranking:0', x: 'closed:0' };
      expectObservable(poll.events().pipe(map(trace))).toBe('s 999ms (x|)', values);
      expectObservable(poll.events().pipe(map(trace)), '1001ms ^').toBe('1001ms (x|)', values);
    });
  });

  it('rejeita votos no prazo mesmo antes de o callback do timer ser executado', () => {
    const scheduler = time();
    let now = 0;
    scheduler.run(({ expectObservable }) => {
      const registry = new PollRegistry({
        scheduler, clock: { now: () => now, toIso: iso }, ids: { next: () => 'id' },
        maxVotesPerUser: 3, rankingThrottleMs: 10,
      });
      const poll = makePoll(registry, 1);
      scheduler.schedule(() => {
        now = 1000;
        expect(registry.vote(poll.id, { voteId: 'late', userId: 'u', option: 'A' }))
          .toMatchObject({ error: 'POLL_CLOSED' });
      }, 5);
      expectObservable(poll.events().pipe(map(trace))).toBe('s 4ms (x|)', { s: 'ranking:0', x: 'closed:0' });
    });
  });

  it('reinicia o heartbeat a cada evento, repete durante o ócio e para no fechamento', () => {
    const scheduler = time();
    scheduler.run(({ expectObservable }) => {
      const poll = makePoll(createRegistry(scheduler, 1000));
      scheduler.schedule(() => poll.vote(1), 10000);
      scheduler.schedule(() => poll.close(), 45000);
      expectObservable(poll.events().pipe(map(trace))).toBe('s 9999ms a 14999ms h 14999ms h 4999ms (x|)', {
        s: 'ranking:0', a: 'ranking:1', h: 'heartbeat', x: 'closed:1',
      });
    });
  });
});
