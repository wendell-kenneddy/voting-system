export type ErrorCode = 'INVALID_POLL' | 'INVALID_VOTE' | 'POLL_NOT_FOUND' |
  'POLL_CLOSED' | 'UNKNOWN_OPTION' | 'USER_VOTE_LIMIT' | 'SERVICE_UNAVAILABLE';

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode, message: string) {
    super(message);
  }
}
