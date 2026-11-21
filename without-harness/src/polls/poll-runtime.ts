import { asyncScheduler, Subject, throttleTime, type SchedulerLike, type Subscription } from 'rxjs';
import type { ClosedRanking, OpenRanking, PollEvent } from '../domain/types';

export interface RuntimeDependencies { scheduler?: SchedulerLike; now?: () => number }

export class PollRuntime {
  private readonly changes = new Subject<void>();
  private readonly output = new Subject<PollEvent>();
  readonly events = this.output.asObservable();
  private readonly pipeline: Subscription;
  private publication: Subscription | null = null;
  private deadline: Subscription | null = null;
  private stopped = false;
  private lastPublishedVersion = 0;

  constructor(
    interval: number,
    private readonly snapshot: () => OpenRanking,
    private readonly scheduler: SchedulerLike = asyncScheduler,
  ) {
    this.pipeline = this.changes.pipe(throttleTime(interval, scheduler, { leading: true, trailing: true }))
      .subscribe(() => {
        const data = this.snapshot();
        // A trailing snapshot also covers votes whose notification is still queued.
        // Cancel that notification so it cannot renew the throttle without a change.
        this.publication?.unsubscribe();
        this.publication = null;
        if (data.version === this.lastPublishedVersion) return;
        this.lastPublishedVersion = data.version;
        this.output.next({ event: 'ranking', data });
      });
  }

  scheduleDeadline(delayMs: number, close: () => void): void {
    this.deadline = this.scheduler.schedule(() => {
      this.deadline = null;
      close();
    }, delayMs);
  }

  changed(): void {
    if (this.stopped || this.publication) return;
    // Fan-out happens in a later scheduler turn, outside the vote command.
    this.publication = this.scheduler.schedule(() => {
      this.publication = null;
      this.changes.next();
    }, 0);
  }

  private stopScheduling(): void {
    this.stopped = true;
    this.publication?.unsubscribe();
    this.publication = null;
    this.deadline?.unsubscribe();
    this.deadline = null;
    // Unsubscribe before completing: completion must never flush a trailing ranking.
    this.pipeline.unsubscribe();
    this.changes.complete();
  }

  close(data: ClosedRanking): void {
    if (this.stopped) return;
    this.stopScheduling();
    this.output.next({ event: 'closed', data });
    this.output.complete();
  }

  dispose(): void {
    this.stopScheduling();
    this.output.complete();
  }

  get resources() {
    return {
      pipeline: this.pipeline.closed ? 0 : 1,
      publication: this.publication ? 1 : 0,
      deadline: this.deadline ? 1 : 0,
      subscribers: this.output.observers.length,
    };
  }
}
