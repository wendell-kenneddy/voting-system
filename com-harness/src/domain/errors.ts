export type ErrorCode =
  | 'INVALID_POLL'
  | 'INVALID_VOTE'
  | 'POLL_NOT_FOUND'
  | 'POLL_CLOSED'
  | 'UNKNOWN_OPTION'
  | 'USER_VOTE_LIMIT';

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure(error: ErrorCode): Result<never> {
  return { ok: false, error };
}
