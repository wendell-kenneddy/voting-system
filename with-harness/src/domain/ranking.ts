import type { Poll } from './poll';

export interface RankingEntry {
  readonly position: number;
  readonly option: string;
  readonly votes: number;
}

interface RankingData {
  readonly pollId: string;
  readonly version: number;
  readonly totalVotes: number;
  readonly ranking: readonly RankingEntry[];
  readonly updatedAt: string;
}

export type OpenRanking = RankingData & { readonly status: 'open' };
export type ClosedRanking = RankingData & { readonly status: 'closed'; readonly closedAt: string };
export type Ranking = OpenRanking | ClosedRanking;

export function buildRanking(poll: Poll): Ranking {
  const ranking = poll.options.map((option, order) => ({ option, votes: poll.optionVotes.get(option) ?? 0, order }))
    .sort((a, b) => b.votes - a.votes || a.order - b.order)
    .map(({ option, votes }, index) => ({ position: index + 1, option, votes }));
  const data = { pollId: poll.id, version: poll.version, totalVotes: poll.version, ranking, updatedAt: poll.updatedAt };
  return poll.closedAt === null
    ? { ...data, status: 'open' }
    : { ...data, status: 'closed', closedAt: poll.closedAt };
}
