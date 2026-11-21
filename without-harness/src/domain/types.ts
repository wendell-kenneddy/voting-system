import type { PollRuntime } from '../polls/poll-runtime';

export interface PollInput { title: string; options: string[]; durationSeconds?: number | null }
export interface VoteInput { voteId: string; userId: string; option: string }
export interface RankingEntry { position: number; option: string; votes: number }
interface RankingBase {
  pollId: string;
  version: number;
  totalVotes: number;
  ranking: RankingEntry[];
  updatedAt: string;
}
export interface OpenRanking extends RankingBase { status: 'open' }
export interface ClosedRanking extends RankingBase { status: 'closed'; closedAt: string }
export type Ranking = OpenRanking | ClosedRanking;
export type PollDetails = Ranking & { title: string; closesAt: string | null; closedAt: string | null };
export interface CreatedPoll {
  id: string; title: string; options: string[]; status: 'open'; closesAt: string | null;
}
export type PollEvent = { event: 'ranking'; data: OpenRanking } | { event: 'closed'; data: ClosedRanking };
export interface PollState {
  id: string;
  title: string;
  options: readonly string[];
  optionIndexes: Map<string, number>;
  counts: number[];
  acceptedVoteIds: Set<string>;
  userVoteCounts: Map<string, number>;
  version: number;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  closesAt: string | null;
  closedAt: string | null;
  deadlineMs: number | null;
  runtime: PollRuntime;
}
