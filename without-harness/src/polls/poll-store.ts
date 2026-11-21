import { DomainError } from '../domain/errors';
import type { PollState } from '../domain/types';

export class PollStore {
  readonly polls = new Map<string, PollState>();
  private disposed = false;

  assertActive(): void {
    if (this.disposed) throw new DomainError(503, 'SERVICE_UNAVAILABLE', 'Application is shutting down');
  }

  get(id: string): PollState {
    this.assertActive();
    const poll = this.polls.get(id);
    if (!poll) throw new DomainError(404, 'POLL_NOT_FOUND', 'Poll not found');
    return poll;
  }

  dispose(): void {
    this.disposed = true;
    for (const poll of this.polls.values()) poll.runtime.dispose();
    this.polls.clear();
  }
}
