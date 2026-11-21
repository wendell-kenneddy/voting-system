import {
  catchError, concat, defer, distinctUntilChanged, EMPTY, map, merge, mergeMap, type Observable,
  of, share, Subject, Subscription, switchMap, takeUntil, takeWhile, throttleTime, timer,
} from 'rxjs';
import type { Result } from '../domain/errors';
import { applyVote, closePoll, type Poll, type VoteReceipt } from '../domain/poll';
import { buildRanking, type ClosedRanking, type OpenRanking, type Ranking } from '../domain/ranking';
import type { Vote } from '../domain/validation';
import type { SchedulerLike } from './ports';

interface ClosedEvent {
  readonly kind: 'closed';
  readonly ranking: ClosedRanking;
}

type DataEvent = { readonly kind: 'ranking'; readonly ranking: OpenRanking } | ClosedEvent;
export type StreamEvent = DataEvent | { readonly kind: 'heartbeat' };
export type PollStream = Observable<StreamEvent>;

const heartbeatMs = 15_000;

function reportError(error: unknown): void {
  console.error('Falha no fluxo da enquete.', error);
}

function skipFailedEvent(error: unknown) {
  reportError(error);
  return EMPTY;
}

export class PollRuntime {
  private readonly stateSubject = new Subject<number>();
  private readonly closedSubject = new Subject<ClosedEvent>();
  private readonly resources = new Subscription();
  private readonly closed$ = this.closedSubject.asObservable();
  private readonly ranking$: Observable<DataEvent>;

  constructor(
    private readonly poll: Poll,
    private readonly scheduler: SchedulerLike,
    throttleMs: number,
  ) {
    this.ranking$ = this.stateSubject.asObservable().pipe(
      distinctUntilChanged(),
      throttleTime(throttleMs, scheduler, { leading: true, trailing: true }),
      mergeMap(() => defer(() => of(this.snapshotEvent())).pipe(catchError(skipFailedEvent))),
      takeUntil(this.closed$),
      share(),
    );
    // A cadência pertence à enquete e continua entre conexões.
    this.resources.add(this.ranking$.subscribe({ error: reportError }));
  }

  snapshot(): Ranking {
    return buildRanking(this.poll);
  }

  vote(vote: Vote, now: string, maxVotesPerUser: number): Result<VoteReceipt> {
    const result = applyVote(this.poll, vote, now, maxVotesPerUser);
    if (result.ok && result.value.status === 'accepted') {
      this.stateSubject.next(this.poll.version);
    }
    return result;
  }

  scheduleClose(delay: number, close: () => void): void {
    this.resources.add(timer(delay, this.scheduler).pipe(
      map(() => close()),
      catchError(skipFailedEvent),
    ).subscribe({ error: reportError }));
  }

  close(now: string): ClosedRanking {
    closePoll(this.poll, now);
    const final = this.snapshot();
    if (final.status !== 'closed') {
      throw new Error('O ranking final deve refletir o fechamento da enquete.');
    }
    return final;
  }

  publishClose(ranking: ClosedRanking): void {
    this.closedSubject.next({ kind: 'closed', ranking });
    this.closedSubject.complete();
    this.stateSubject.complete();
    this.resources.unsubscribe();
  }

  events(): PollStream {
    return defer(() => {
      const initial = this.snapshotEvent();
      if (initial.kind === 'closed') {
        return of(initial);
      }
      return concat(of(initial), merge(this.ranking$, this.closed$));
    }).pipe(
      switchMap(event => event.kind === 'closed' ? of(event) : concat(
        of(event),
        timer(heartbeatMs, heartbeatMs, this.scheduler).pipe(map(() => ({ kind: 'heartbeat' } as const))),
      )),
      takeWhile(event => event.kind !== 'closed', true),
    );
  }

  private snapshotEvent(): DataEvent {
    const ranking = this.snapshot();
    return ranking.status === 'open' ? { kind: 'ranking', ranking } : { kind: 'closed', ranking };
  }
}
