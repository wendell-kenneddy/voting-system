import { failure, ok, type Result } from './errors';
import type { PollInput, Vote } from './validation';

export interface Poll {
  readonly id: string;
  readonly title: string;
  readonly options: readonly string[];
  readonly closesAt: string | null;
  readonly optionVotes: Map<string, number>;
  readonly userVotes: Map<string, number>;
  readonly voteIds: Set<string>;
  closedAt: string | null;
  updatedAt: string;
  version: number;
}

export interface VoteReceipt {
  status: 'accepted' | 'duplicate';
  voteId: string;
}

export function createPoll(id: string, input: PollInput, now: string, closesAt: string | null): Poll {
  const options = [...input.options];
  return {
    id, title: input.title, options, closesAt,
    optionVotes: new Map(options.map(option => [option, 0])),
    userVotes: new Map(),
    voteIds: new Set(),
    closedAt: null, updatedAt: now, version: 0,
  };
}

export function applyVote(poll: Poll, vote: Vote, now: string, maxVotesPerUser: number): Result<VoteReceipt> {
  if (poll.closedAt !== null) {
    return failure('POLL_CLOSED');
  }
  const optionVotes = poll.optionVotes.get(vote.option);
  if (optionVotes === undefined) {
    return failure('UNKNOWN_OPTION');
  }
  if (poll.voteIds.has(vote.voteId)) {
    return ok({ status: 'duplicate', voteId: vote.voteId });
  }
  const userVotes = poll.userVotes.get(vote.userId) ?? 0;
  if (userVotes >= maxVotesPerUser) {
    return failure('USER_VOTE_LIMIT');
  }

  poll.voteIds.add(vote.voteId);
  poll.optionVotes.set(vote.option, optionVotes + 1);
  poll.userVotes.set(vote.userId, userVotes + 1);
  poll.version++;
  poll.updatedAt = now;
  return ok({ status: 'accepted', voteId: vote.voteId });
}

export function closePoll(poll: Poll, now: string): void {
  if (poll.closedAt === null) {
    poll.closedAt = now;
    poll.updatedAt = now;
  }
}
