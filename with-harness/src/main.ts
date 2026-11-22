import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { queueScheduler, type SchedulerAction, Subscription } from 'rxjs';
import { PollRegistry } from './application/pollRegistry';
import type { Clock, SchedulerLike } from './application/ports';
import { readConfig } from './config';
import { createApp } from './infra/http/app';

export const systemClock: Clock = {
  now: Date.now,
  toIso: time => new Date(time).toISOString(),
};

const maxTimerDelay = 2_147_483_647;

export const nodeScheduler: SchedulerLike = {
  now: systemClock.now,
  schedule<T>(work: (this: SchedulerAction<T>, state?: T) => void, delay = 0, state?: T): Subscription {
    let pending: Subscription | undefined;
    const action: SchedulerAction<T> = Object.assign(new Subscription(() => {
      pending?.unsubscribe();
      pending = undefined;
    }), {
      schedule(nextState?: T, nextDelay = 0): Subscription {
        if (action.closed) return action;
        pending?.unsubscribe();
        const task = new Subscription();
        pending = task;
        function run(): void {
          pending = undefined;
          task.unsubscribe();
          work.call(action, nextState);
        }

        if (nextDelay <= 0) {
          task.add(queueScheduler.schedule(run));
        } else {
          let timeout: NodeJS.Timeout;
          function wait(remaining: number): void {
            const chunk = Math.min(remaining, maxTimerDelay);
            timeout = setTimeout(remaining > chunk ? () => wait(remaining - chunk) : run, chunk).unref();
          }
          task.add(() => clearTimeout(timeout));
          wait(nextDelay);
        }
        return action;
      },
    });
    return action.schedule(state, delay);
  },
};

function start(): void {
  const { port, maxVotesPerUser, rankingThrottleMs } = readConfig(process.env);
  const registry = new PollRegistry({
    clock: systemClock, ids: { next: randomUUID }, scheduler: nodeScheduler, maxVotesPerUser, rankingThrottleMs,
  });
  const server = createServer(createApp(registry));
  server.once('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, () => {
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`Servidor HTTP ouvindo na porta ${boundPort}.`);
  });

  function shutdown(): void {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    server.close();
    registry.dispose();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
