import { performance } from 'node:perf_hooks';
import { Agent } from 'node:http';
import { Subscription } from 'rxjs';
import type { Response } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { nodeScheduler } from '../../src/main';
import { httpFixture } from './fixture';

const fixture = httpFixture();
beforeAll(fixture.start);
afterAll(fixture.stop);

it('aceita 1.000 votos em 5 enquetes distribuídos ao longo de cerca de 2 s', async () => {
  const ids = await Promise.all(Array.from({ length: 5 }, () => fixture.createPoll()));
  const schedule = new Subscription();
  const agent = new Agent({ keepAlive: true, maxSockets: 24 });
  const started = performance.now();
  try {
    const batches = Array.from({ length: 20 }, (_, batch) => new Promise<Response[]>(resolve => {
      schedule.add(nodeScheduler.schedule(() => {
        const votes = Array.from({ length: 50 }, (_, index) => {
          const number = batch * 50 + index;
          return fixture.vote(ids[index % ids.length], `vote-${number}`, `user-${number}`, index % 2 === 0 ? 'A' : 'B')
            .agent(agent);
        });
        resolve(Promise.all(votes));
      }, batch * 100));
    }));
    const responses = (await Promise.all(batches)).flat();
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_850);
    expect(responses).toHaveLength(1_000);
    expect(responses.filter(response => response.status === 202)).toHaveLength(1_000);
    for (const id of ids) {
      await fixture.api.get(`/polls/${id}`).expect(200).expect(response => {
        expect(response.body).toMatchObject({ version: 200, totalVotes: 200,
          ranking: [{ position: 1, option: 'A', votes: 100 }, { position: 2, option: 'B', votes: 100 }] });
      });
    }
  } finally {
    schedule.unsubscribe();
    agent.destroy();
  }
}, 15_000);
