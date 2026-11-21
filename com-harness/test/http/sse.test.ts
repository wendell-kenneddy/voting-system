import { performance } from 'node:perf_hooks';
import type { SchedulerAction, SchedulerLike, Subscription } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeScheduler, systemClock } from '../../src/main';
import { httpFixture, testRegistry, type SseFrame } from './fixture';

type Client = Awaited<ReturnType<ReturnType<typeof httpFixture>['connect']>>;

async function dataFrame(client: Client, kind: 'ranking' | 'closed', version: number) {
  const frame = await client.next();
  if (!frame || frame.kind === 'heartbeat') throw new Error('Esperava um evento SSE com dados.');
  expect(frame).toMatchObject({ kind, id: version, data: { version, totalVotes: version } });
  return frame;
}

const fixture = httpFixture();
beforeAll(fixture.start);
afterAll(fixture.stop);

it('entrega snapshots imediatos e compartilha leading e trailing sem afetar outra enquete', async () => {
  const id = await fixture.createPoll();
  const otherId = await fixture.createPoll();
  const connectedAt = performance.now();
  const [first, second, other] = await Promise.all([
    fixture.connect(id), fixture.connect(id), fixture.connect(otherId),
  ]);
  for (const client of [first, second, other]) {
    expect(client.response.statusCode).toBe(200);
    expect(client.response.headers['content-type']).toMatch(/^text\/event-stream/);
  }
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    dataFrame(first, 'ranking', 0), dataFrame(second, 'ranking', 0), dataFrame(other, 'ranking', 0),
  ]);
  expect(firstSnapshot.receivedAt - connectedAt).toBeLessThanOrEqual(500);
  expect(firstSnapshot.data).toEqual(secondSnapshot.data);
  expect(firstSnapshot.data).toEqual({
    pollId: id, status: 'open', version: 0, totalVotes: 0, updatedAt: expect.any(String),
    ranking: [{ position: 1, option: 'A', votes: 0 }, { position: 2, option: 'B', votes: 0 }],
  });

  const started = performance.now();
  await fixture.vote(id, '1').expect(202);
  const [leading, secondLeading] = await Promise.all([
    dataFrame(first, 'ranking', 1), dataFrame(second, 'ranking', 1),
  ]);
  expect(leading.receivedAt - started).toBeLessThanOrEqual(300);
  expect(leading.data).toEqual(secondLeading.data);
  await Promise.all([fixture.vote(id, '2').expect(202), fixture.vote(id, '3').expect(202)]);
  await fixture.api.get(`/polls/${id}`).expect(200)
    .expect(response => expect(response.body.version).toBe(3));
  const late = await fixture.connect(id);
  await dataFrame(late, 'ranking', 3);

  const otherStarted = performance.now();
  await fixture.vote(otherId, '1').expect(202);
  const otherLeading = await dataFrame(other, 'ranking', 1);
  expect(otherLeading.receivedAt - otherStarted).toBeLessThanOrEqual(300);
  expect(otherLeading.data).toMatchObject({ pollId: otherId, status: 'open' });

  const [trailing, secondTrailing, lateTrailing] = await Promise.all([
    dataFrame(first, 'ranking', 3), dataFrame(second, 'ranking', 3), dataFrame(late, 'ranking', 3),
  ]);
  expect(trailing.receivedAt - leading.receivedAt).toBeGreaterThanOrEqual(900);
  expect(trailing.data).toEqual(secondTrailing.data);
  expect(trailing.data).toEqual(lateTrailing.data);
  await fixture.api.post(`/polls/${id}/close`).expect(200);
  for (const client of [first, second, late]) {
    await dataFrame(client, 'closed', 3);
    expect(await client.next()).toBeNull();
  }
  await fixture.vote(otherId, '2').expect(202);
  await dataFrame(other, 'ranking', 2);
  other.close();
});

it('fecha automaticamente no prazo e entrega EOF', async () => {
  const started = performance.now();
  const id = await fixture.createPoll({ title: 'Com prazo', options: ['A', 'B'], durationSeconds: 1 });
  const client = await fixture.connect(id);
  await dataFrame(client, 'ranking', 0);
  const closed = await dataFrame(client, 'closed', 0);
  expect(closed.receivedAt - started).toBeGreaterThanOrEqual(500);
  expect(closed.receivedAt - started).toBeLessThanOrEqual(1_500);
  expect(await client.next()).toBeNull();
  const result = await fixture.api.get(`/polls/${id}`).expect(200);
  const difference = Date.parse(result.body.closedAt) - Date.parse(result.body.closesAt);
  expect(Math.abs(difference)).toBeLessThanOrEqual(500);
  expect(result.body).toMatchObject({ closedAt: result.body.updatedAt, status: 'closed', totalVotes: 0 });
});

describe('encerramento manual com trailing pendente', () => {
  const longThrottle = httpFixture(testRegistry({ rankingThrottleMs: 10_000 }));
  beforeAll(longThrottle.start);
  afterAll(longThrottle.stop);

  it('entrega o mesmo ranking final aos clientes atuais e novos e encerra sem esperar o throttle', async () => {
    const id = await longThrottle.createPoll({ title: 'Com prazo', options: ['A', 'B'], durationSeconds: 60 });
    const [first, second] = await Promise.all([longThrottle.connect(id), longThrottle.connect(id)]);
    await Promise.all([dataFrame(first, 'ranking', 0), dataFrame(second, 'ranking', 0)]);
    await longThrottle.vote(id, '1').expect(202);
    await Promise.all([dataFrame(first, 'ranking', 1), dataFrame(second, 'ranking', 1)]);
    await longThrottle.vote(id, '2', 'u2', 'B').expect(202);
    const started = performance.now();
    const final = await longThrottle.api.post(`/polls/${id}/close`).expect(200);
    expect(final.body).toMatchObject({
      totalVotes: 2, version: 2, status: 'closed', closedAt: final.body.updatedAt,
      ranking: [{ position: 1, option: 'A', votes: 1 }, { position: 2, option: 'B', votes: 1 }],
    });
    for (const client of [first, second]) {
      const closed = await dataFrame(client, 'closed', 2);
      expect(closed.receivedAt - started).toBeLessThanOrEqual(500);
      expect(closed.data).toEqual(final.body);
      expect(await client.next()).toBeNull();
      expect(performance.now() - started).toBeLessThanOrEqual(500);
    }
    const reconnectedAt = performance.now();
    const newClient = await longThrottle.connect(id);
    const closed = await dataFrame(newClient, 'closed', 2);
    expect(closed.receivedAt - reconnectedAt).toBeLessThanOrEqual(500);
    expect(closed.data).toEqual(final.body);
    expect(await newClient.next()).toBeNull();
  });
});

describe('teardown e resiliência', () => {
  const heartbeatActions = new Set<Subscription>();
  let onCancel: (() => void) | undefined;
  const tracker: SchedulerLike = {
    now: () => nodeScheduler.now(),
    schedule<T>(work: (this: SchedulerAction<T>, state?: T) => void, delay?: number, state?: T) {
      const action = nodeScheduler.schedule(work, delay, state);
      if (delay === 15_000) {
        heartbeatActions.add(action);
        action.add(() => {
          heartbeatActions.delete(action);
          onCancel?.();
          onCancel = undefined;
        });
      }
      return action;
    },
  };
  let failVote = false;
  const controlled = httpFixture(testRegistry({
    scheduler: tracker,
    clock: {
      toIso: systemClock.toIso,
      now: () => {
        if (failVote) {
          failVote = false;
          throw new Error('falha transitória no relógio');
        }
        return systemClock.now();
      },
    },
  }));
  beforeAll(controlled.start);
  afterAll(controlled.stop);

  it('cancela só o heartbeat do cliente desconectado, sobrevive a erros e continua votando', async () => {
    const id = await controlled.createPoll();
    const [first, second] = await Promise.all([controlled.connect(id), controlled.connect(id)]);
    await Promise.all([dataFrame(first, 'ranking', 0), dataFrame(second, 'ranking', 0)]);
    expect(heartbeatActions.size).toBe(2);
    const canceled = new Promise<void>(resolve => { onCancel = resolve; });
    first.close();
    await canceled;
    expect(heartbeatActions.size).toBe(1);

    await controlled.api.post(`/polls/${id}/votes`).send({ option: 'A' }).expect(400);
    failVote = true;
    await controlled.vote(id, 'retry').expect('Content-Type', /application\/json/).expect(500)
      .expect(response => expect(response.body).toEqual({ error: 'INTERNAL_ERROR', message: expect.any(String) }));
    await controlled.api.get(`/polls/${id}`).expect(200).expect(response => expect(response.body.version).toBe(0));
    await controlled.vote(id, 'retry').expect(202);
    await dataFrame(second, 'ranking', 1);
    await controlled.api.post(`/polls/${id}/close`).expect(200);
    await dataFrame(second, 'closed', 1);
    expect(await second.next()).toBeNull();
    expect(heartbeatActions.size).toBe(0);
  });
});

describe('heartbeat no protocolo', () => {
  const scheduler = new TestScheduler((actual: unknown, expected: unknown) => expect(actual).toEqual(expected));
  const virtual = httpFixture(testRegistry({ scheduler }));
  beforeAll(virtual.start);
  afterAll(virtual.stop);

  it('transmite o comentário SSE e mantém a conexão utilizável', async () => {
    const id = await virtual.createPoll();
    const client = await virtual.connect(id);
    await dataFrame(client, 'ranking', 0);
    scheduler.maxFrames = 15_000;
    scheduler.flush();
    const comment: SseFrame | null = await client.next();
    expect(comment?.kind).toBe('heartbeat');
    await virtual.vote(id, '1').expect(202);
    await dataFrame(client, 'ranking', 1);
    await virtual.api.post(`/polls/${id}/close`).expect(200);
    await dataFrame(client, 'closed', 1);
    expect(await client.next()).toBeNull();
  });
});
