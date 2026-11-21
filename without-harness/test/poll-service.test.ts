import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pollBody, voteBody } from './helpers/builders';

describe('synchronous poll commands', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const instances: ReturnType<typeof createApp>[] = [];
  function setup(maxVotesPerUser = 3) {
    const instance = createApp({ port: 3000, maxVotesPerUser, rankingThrottleMs: 10000 }, { now: () => now });
    instances.push(instance);
    return instance;
  }
  afterEach(() => { for (const instance of instances.splice(0)) instance.dispose(); });

  it('ranks all options with stable ties, immutable snapshots and immediate counts (RN-06)', () => {
    const { service } = setup();
    const poll = service.create(pollBody());
    const before = service.details(poll.id);
    now++;
    service.vote(poll.id, voteBody('a', 'u', 'Go'));
    const first = service.details(poll.id);
    service.vote(poll.id, voteBody('b', 'u', 'TypeScript'));
    const second = service.details(poll.id);
    expect(before.version).toBe(0);
    expect(before.ranking.every(row => row.votes === 0)).toBe(true);
    expect(first.ranking.map(row => row.option)).toEqual(['Go', 'TypeScript', 'Rust']);
    expect(first.updatedAt).not.toBe(before.updatedAt);
    expect(second.ranking).toEqual([
      { position: 1, option: 'TypeScript', votes: 1 }, { position: 2, option: 'Go', votes: 1 }, { position: 3, option: 'Rust', votes: 0 },
    ]);
    second.ranking[0]!.votes = 99;
    expect(service.details(poll.id).totalVotes).toBe(2);
    expect(service.details(poll.id).ranking[0]!.votes).toBe(1);
  });

  it('idempotence precedes quota; IDs and users are local to polls (RN-01/02/03)', () => {
    const { service } = setup(1);
    const a = service.create(pollBody());
    const b = service.create(pollBody());
    service.vote(a.id, voteBody());
    const original = service.details(a.id);
    now += 10;
    expect(service.vote(a.id, voteBody('v1', 'other', 'Go')).status).toBe('duplicate');
    expect(service.vote(a.id, voteBody()).status).toBe('duplicate');
    expect(service.details(a.id)).toEqual(original);
    expect(() => service.vote(a.id, voteBody('v2'))).toThrow(expect.objectContaining({ code: 'USER_VOTE_LIMIT' }));
    expect(service.vote(a.id, voteBody('v2', 'other')).status).toBe('accepted');
    expect(service.vote(b.id, voteBody()).status).toBe('accepted');
    expect(service.details(b.id).version).toBe(1);
    service.close(a.id);
    expect(service.details(b.id).status).toBe('open');
  });

  it('supports opaque identifiers and preserves exact option matching', () => {
    const { service } = setup(1);
    const poll = service.create(pollBody({ title: ' Title ', options: ['A', 'a', ' A ', '__proto__'] }));
    for (const id of ['__proto__', 'U', 'u', ' u ', 'é', 'e\u0301']) service.vote(poll.id, voteBody(id, id, '__proto__'));
    expect(service.details(poll.id).version).toBe(6);
    expect(poll.title).toBe(' Title ');
    expect(() => service.vote(poll.id, voteBody('next', 'new', ' A'))).toThrow(expect.objectContaining({ code: 'UNKNOWN_OPTION' }));
  });

  it('respects a zero quota', () => {
    const { service } = setup(0);
    const poll = service.create(pollBody());
    expect(() => service.vote(poll.id, voteBody())).toThrow(expect.objectContaining({ code: 'USER_VOTE_LIMIT' }));
    expect(service.details(poll.id).version).toBe(0);
  });

  it('applies overdue deadlines synchronously while preserving invalid-body precedence (RN-09)', () => {
    const { service } = setup();
    const poll = service.create(pollBody({ durationSeconds: 1 }));
    now += 1001;
    expect(() => service.vote(poll.id, {})).toThrow(expect.objectContaining({ code: 'INVALID_VOTE' }));
    expect(() => service.vote(poll.id, voteBody())).toThrow(expect.objectContaining({ code: 'POLL_CLOSED' }));
    const final = service.close(poll.id);
    now += 1000;
    expect(service.close(poll.id)).toEqual(final);
    expect(final.updatedAt).toBe(final.closedAt);
    expect(service.details(poll.id).closesAt).toBe(poll.closesAt);
  });
});
