export type { SchedulerLike } from 'rxjs';

export interface Clock {
  now(): number;
  toIso(time: number): string;
}

export interface IdGenerator {
  next(): string;
}
