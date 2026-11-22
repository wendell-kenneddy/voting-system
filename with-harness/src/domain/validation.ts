import { failure, ok, type Result } from './errors';

export interface PollInput {
  title: string;
  options: readonly string[];
  durationSeconds: number | null;
}

export interface Vote {
  voteId: string;
  userId: string;
  option: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength = Infinity): value is string {
  return typeof value === 'string' && /\S/u.test(value) && [...value].length <= maxLength;
}

function isDuration(value: unknown): value is number | null | undefined {
  return value === null || value === undefined
    || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 86400);
}

export function validatePoll(body: unknown): Result<PollInput> {
  if (!isObject(body)) {
    return failure('INVALID_POLL');
  }
  const { title, options, durationSeconds } = body;
  if (!isText(title, 200) || !Array.isArray(options) || options.length < 2 || options.length > 10
    || !options.every(option => isText(option, 100)) || new Set(options).size !== options.length
    || !isDuration(durationSeconds)) {
    return failure('INVALID_POLL');
  }
  return ok({ title, options, durationSeconds: durationSeconds ?? null });
}

export function validateVote(body: unknown): Result<Vote> {
  if (!isObject(body)) {
    return failure('INVALID_VOTE');
  }
  const { voteId, userId, option } = body;
  if (!isText(voteId, 100) || !isText(userId, 100) || !isText(option)) {
    return failure('INVALID_VOTE');
  }
  return ok({ voteId, userId, option });
}
