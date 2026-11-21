import { randomUUID } from 'node:crypto';
import { asyncScheduler } from 'rxjs';
import type { Config } from '../config';
import { DomainError } from '../domain/errors';
import { projectRanking } from '../domain/ranking';
import type { ClosedRanking, CreatedPoll, OpenRanking, PollDetails, PollState } from '../domain/types';
import { validatePoll, validateVote } from '../domain/validation';
import { PollRuntime, type RuntimeDependencies } from './poll-runtime';
import { PollStore } from './poll-store';

export class PollService {
  private readonly now: () => number;
  private readonly scheduler;

  constructor(readonly store: PollStore, private readonly config: Config, dependencies: RuntimeDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.scheduler = dependencies.scheduler ?? asyncScheduler;
  }

  create(body: unknown): CreatedPoll {
    this.store.assertActive();
    const input = validatePoll(body);
    const createdMs = this.now();
    const createdAt = new Date(createdMs).toISOString();
    const deadlineMs = input.durationSeconds == null ? null : createdMs + input.durationSeconds * 1000;
    const runtime = new PollRuntime(this.config.rankingThrottleMs,
      () => projectRanking(poll) as OpenRanking, this.scheduler);
    const poll: PollState = {
      id: randomUUID(), title: input.title, options: input.options,
      optionIndexes: new Map(input.options.map((option, index) => [option, index])),
      counts: input.options.map(() => 0), acceptedVoteIds: new Set(), userVoteCounts: new Map(),
      version: 0, status: 'open', createdAt, updatedAt: createdAt,
      closesAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
      closedAt: null, deadlineMs, runtime,
    };
    this.store.polls.set(poll.id, poll);
    if (deadlineMs !== null) runtime.scheduleDeadline(Math.max(0, deadlineMs - this.now()), () => this.finish(poll));
    return { id: poll.id, title: poll.title, options: [...poll.options], status: 'open', closesAt: poll.closesAt };
  }

  current(id: string): PollState {
    const poll = this.store.get(id);
    this.checkDeadline(poll);
    return poll;
  }

  details(id: string): PollDetails {
    const poll = this.current(id);
    const ranking = projectRanking(poll);
    const metadata = { title: poll.title, closesAt: poll.closesAt };
    return ranking.status === 'closed' ? { ...ranking, ...metadata }
      : { ...ranking, ...metadata, closedAt: null };
  }

  vote(id: string, body: unknown): { status: 'accepted' | 'duplicate'; voteId: string } {
    const poll = this.store.get(id);
    const vote = validateVote(body);
    this.checkDeadline(poll);
    if (poll.status === 'closed') throw new DomainError(409, 'POLL_CLOSED', 'Poll is closed');
    const index = poll.optionIndexes.get(vote.option);
    if (index === undefined) throw new DomainError(422, 'UNKNOWN_OPTION', 'Option does not belong to this poll');
    if (poll.acceptedVoteIds.has(vote.voteId)) return { status: 'duplicate', voteId: vote.voteId };
    const userCount = poll.userVoteCounts.get(vote.userId) ?? 0;
    if (userCount >= this.config.maxVotesPerUser) throw new DomainError(409, 'USER_VOTE_LIMIT', 'User vote limit reached');
    poll.acceptedVoteIds.add(vote.voteId);
    poll.userVoteCounts.set(vote.userId, userCount + 1);
    poll.counts[index] = poll.counts[index]! + 1;
    poll.version++;
    poll.updatedAt = new Date(this.now()).toISOString();
    poll.runtime.changed();
    return { status: 'accepted', voteId: vote.voteId };
  }

  close(id: string): ClosedRanking {
    return this.finish(this.current(id));
  }

  private checkDeadline(poll: PollState): void {
    if (poll.status === 'open' && poll.deadlineMs !== null && this.now() >= poll.deadlineMs) this.finish(poll);
  }

  private finish(poll: PollState): ClosedRanking {
    if (poll.status === 'closed') return projectRanking(poll) as ClosedRanking;
    const timestamp = new Date(this.now()).toISOString();
    poll.status = 'closed';
    poll.closedAt = timestamp;
    poll.updatedAt = timestamp;
    const final = projectRanking(poll) as ClosedRanking;
    poll.runtime.close(final);
    return final;
  }
}
