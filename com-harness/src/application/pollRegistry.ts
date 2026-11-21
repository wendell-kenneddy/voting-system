import { of } from 'rxjs';
import { failure, ok, type Result } from '../domain/errors';
import { createPoll, type VoteReceipt } from '../domain/poll';
import type { ClosedRanking, OpenRanking } from '../domain/ranking';
import { validatePoll, validateVote } from '../domain/validation';
import { PollRuntime, type PollStream } from './pollRuntime';
import type { Clock, IdGenerator, SchedulerLike } from './ports';

interface PollMetadata {
  readonly title: string;
  readonly closesAt: string | null;
}

interface OpenPoll {
  readonly kind: 'open';
  readonly metadata: PollMetadata;
  readonly deadline: number | null;
  readonly runtime: PollRuntime;
}

interface ClosedPoll {
  readonly kind: 'closed';
  readonly metadata: PollMetadata;
  readonly ranking: ClosedRanking;
}

interface CreatedPoll extends PollMetadata {
  readonly id: string;
  readonly options: readonly string[];
  readonly status: 'open';
}

interface RegistryOptions {
  clock: Clock;
  ids: IdGenerator;
  scheduler: SchedulerLike;
  maxVotesPerUser: number;
  rankingThrottleMs: number;
}

type PollRecord = OpenPoll | ClosedPoll;
type PollView = PollMetadata & (ClosedRanking | (OpenRanking & { readonly closedAt: null }));

export class PollRegistry {
  private readonly polls = new Map<string, PollRecord>();

  constructor(private readonly options: RegistryOptions) {}

  has(id: string): boolean {
    return this.polls.has(id);
  }

  create(body: unknown): Result<CreatedPoll> {
    const input = validatePoll(body);
    if (!input.ok) return input;

    const { clock, ids, scheduler, rankingThrottleMs } = this.options;
    const { title, options, durationSeconds } = input.value;
    const now = clock.now();
    const delay = durationSeconds === null ? null : durationSeconds * 1_000;
    const deadline = delay === null ? null : now + delay;
    const closesAt = deadline === null ? null : clock.toIso(deadline);
    const id = ids.next();
    const poll = createPoll(id, input.value, clock.toIso(now), closesAt);
    const runtime = new PollRuntime(poll, scheduler, rankingThrottleMs);
    this.polls.set(id, { kind: 'open', metadata: { title, closesAt }, deadline, runtime });
    if (delay !== null) runtime.scheduleClose(delay, () => { this.close(id); });

    return ok({ id, title, options: [...options], status: 'open', closesAt });
  }

  get(id: string): Result<PollView> {
    const poll = this.current(id);
    if (!poll) return failure('POLL_NOT_FOUND');

    const ranking = poll.kind === 'closed' ? poll.ranking : poll.runtime.snapshot();
    return ok(ranking.status === 'closed'
      ? { ...ranking, ...poll.metadata }
      : { ...ranking, ...poll.metadata, closedAt: null });
  }

  vote(id: string, body: unknown): Result<VoteReceipt> {
    const poll = this.polls.get(id);
    if (!poll) return failure('POLL_NOT_FOUND');
    const input = validateVote(body);
    if (!input.ok) return input;
    if (poll.kind === 'closed') return failure('POLL_CLOSED');

    const now = this.options.clock.now();
    if (poll.deadline !== null && now >= poll.deadline) {
      this.finish(id, poll, now);
      return failure('POLL_CLOSED');
    }
    return poll.runtime.vote(input.value, this.options.clock.toIso(now), this.options.maxVotesPerUser);
  }

  close(id: string): Result<ClosedRanking> {
    const poll = this.polls.get(id);
    if (!poll) return failure('POLL_NOT_FOUND');
    return ok(poll.kind === 'closed' ? poll.ranking : this.finish(id, poll, this.options.clock.now()).ranking);
  }

  stream(id: string): Result<PollStream> {
    const poll = this.current(id);
    if (!poll) return failure('POLL_NOT_FOUND');
    return ok(poll.kind === 'closed' ? of({ kind: 'closed', ranking: poll.ranking }) : poll.runtime.events());
  }

  dispose(): void {
    for (const [id, poll] of this.polls) {
      if (poll.kind === 'open') this.finish(id, poll, this.options.clock.now());
    }
    this.polls.clear();
  }

  private current(id: string): PollRecord | undefined {
    const poll = this.polls.get(id);
    if (poll?.kind === 'open' && poll.deadline !== null) {
      const now = this.options.clock.now();
      if (now >= poll.deadline) return this.finish(id, poll, now);
    }
    return poll;
  }

  private finish(id: string, poll: OpenPoll, now: number): ClosedPoll {
    const ranking = poll.runtime.close(this.options.clock.toIso(now));
    const closed: ClosedPoll = { kind: 'closed', metadata: poll.metadata, ranking };
    this.polls.set(id, closed);
    poll.runtime.publishClose(ranking);
    return closed;
  }
}
