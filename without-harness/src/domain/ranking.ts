import type { PollState, Ranking } from './types';

export function projectRanking(poll: PollState): Ranking {
  const ranking = poll.options.map((option, index) => ({ option, votes: poll.counts[index]!, index }))
    .sort((a, b) => b.votes - a.votes || a.index - b.index)
    .map(({ option, votes }, index) => ({ position: index + 1, option, votes }));
  const base = { pollId: poll.id, version: poll.version, totalVotes: poll.version, ranking, updatedAt: poll.updatedAt };
  return poll.status === 'closed'
    ? { ...base, status: 'closed', closedAt: poll.closedAt! }
    : { ...base, status: 'open' };
}
