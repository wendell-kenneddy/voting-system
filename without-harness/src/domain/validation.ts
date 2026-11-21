import { DomainError } from './errors';
import type { PollInput, VoteInput } from './types';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonblank(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function validatePoll(body: unknown): PollInput {
  if (!object(body) || !nonblank(body.title, 200) || !Array.isArray(body.options) ||
      body.options.length < 2 || body.options.length > 10 ||
      !body.options.every(option => nonblank(option, 100)) ||
      new Set(body.options).size !== body.options.length ||
      (body.durationSeconds !== undefined && body.durationSeconds !== null &&
       (typeof body.durationSeconds !== 'number' || !Number.isInteger(body.durationSeconds) ||
        body.durationSeconds < 1 || body.durationSeconds > 86400))) {
    throw new DomainError(400, 'INVALID_POLL', 'Provide a title, 2–10 unique options and an optional duration of 1–86400 seconds');
  }
  return { title: body.title, options: [...body.options] as string[],
    durationSeconds: body.durationSeconds as number | null | undefined };
}

export function validateVote(body: unknown): VoteInput {
  if (!object(body) || !nonblank(body.voteId, 100) || !nonblank(body.userId, 100) || !nonblank(body.option)) {
    throw new DomainError(400, 'INVALID_VOTE', 'Provide nonblank voteId and userId (up to 100 characters) and option');
  }
  return { voteId: body.voteId, userId: body.userId, option: body.option };
}
