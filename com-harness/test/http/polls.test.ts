import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFixture, testRegistry } from './fixture';

const fixture = httpFixture();
const { api } = fixture;

beforeAll(fixture.start);
afterAll(fixture.stop);

function checkError(body: unknown, error: string): void {
  expect(body).toEqual({ error, message: expect.any(String) });
  expect(body).not.toHaveProperty('message', '');
}

describe('criação e consulta', () => {
  it('preserva opções e título, calcula o prazo e retorna o ranking inicial', async () => {
    const created = await api.post('/polls')
      .send({ title: ' Título ', options: [' A ', 'a'], durationSeconds: 86400 })
      .expect('Content-Type', /application\/json/).expect(201);
    const id: unknown = created.body.id;
    expect(typeof id).toBe('string');
    expect(created.body).toEqual({
      id, title: ' Título ', options: [' A ', 'a'], status: 'open', closesAt: expect.any(String),
    });
    const result = await api.get(`/polls/${String(id)}`).expect('Content-Type', /application\/json/).expect(200);
    expect(result.body).toEqual({
      pollId: id, title: ' Título ', status: 'open', version: 0, totalVotes: 0,
      ranking: [{ position: 1, option: ' A ', votes: 0 }, { position: 2, option: 'a', votes: 0 }],
      closesAt: created.body.closesAt, closedAt: null, updatedAt: expect.any(String),
    });
    expect(Date.parse(result.body.closesAt) - Date.parse(result.body.updatedAt)).toBe(86_400_000);
  });

  it.each([undefined, null])('cria sem encerramento automático para duração %s', async durationSeconds => {
    await api.post('/polls').send({ title: 'Linguagens', options: ['A', 'B'], durationSeconds })
      .expect(201).expect(response => expect(response.body.closesAt).toBeNull());
  });

  it.each(['{broken', '[]', 'null', '42', 'false', '"text"', '{}'])('rejeita enquete inválida %s em JSON', async raw => {
    await api.post('/polls').set('Content-Type', 'application/json').send(raw)
      .expect('Content-Type', /application\/json/).expect(400)
      .expect(response => checkError(response.body, 'INVALID_POLL'));
  });

  it.each(['get', 'stream', 'close'])('responde POLL_NOT_FOUND em %s', async kind => {
    const req = kind === 'get' ? api.get('/polls/ausente')
      : kind === 'stream' ? api.get('/polls/ausente/stream') : api.post('/polls/ausente/close');
    await req.expect('Content-Type', /application\/json/).expect(404)
      .expect(response => checkError(response.body, 'POLL_NOT_FOUND'));
  });
});

describe('contrato e precedência do voto', () => {
  it('checa a enquete antes de interpretar JSON malformado', async () => {
    await api.post('/polls/ausente/votes').set('Content-Type', 'application/json').send('{broken')
      .expect('Content-Type', /application\/json/).expect(404)
      .expect(response => checkError(response.body, 'POLL_NOT_FOUND'));
  });

  it.each(['{broken', '[]', 'null', '42', 'false', '"text"', '{}'])('rejeita voto inválido %s em JSON', async raw => {
    const id = await fixture.createPoll();
    await api.post(`/polls/${id}/votes`).set('Content-Type', 'application/json').send(raw)
      .expect('Content-Type', /application\/json/).expect(400)
      .expect(response => checkError(response.body, 'INVALID_VOTE'));
  });

  it('checa opção antes de duplicidade, que vem antes do limite', async () => {
    const id = await fixture.createPoll();
    for (const voteId of [' v ', '2', '3']) {
      await fixture.vote(id, voteId, 'u').expect('Content-Type', /application\/json/)
        .expect(202, { status: 'accepted', voteId });
    }
    await fixture.vote(id, ' v ', 'u', 'a').expect('Content-Type', /application\/json/).expect(422)
      .expect(response => checkError(response.body, 'UNKNOWN_OPTION'));
    await fixture.vote(id, ' v ', 'u', 'B').expect(200, { status: 'duplicate', voteId: ' v ' });
    await fixture.vote(id, '4', 'u').expect('Content-Type', /application\/json/).expect(409)
      .expect(response => checkError(response.body, 'USER_VOTE_LIMIT'));
    await fixture.vote(id, '4', 'U', 'B').expect(202, { status: 'accepted', voteId: '4' });
    const other = await fixture.createPoll();
    await fixture.vote(other, ' v ', 'u').expect(202);
    await api.get(`/polls/${id}`).expect(response => expect(response.body).toMatchObject({ version: 4, totalVotes: 4 }));
    await api.get(`/polls/${other}`).expect(response => expect(response.body).toMatchObject({ version: 1, totalVotes: 1 }));
  });

  it('preserva a ordem corpo inválido, enquete encerrada e duplicidade', async () => {
    const id = await fixture.createPoll();
    await fixture.vote(id, 'v').expect(202);
    const closed = await api.post(`/polls/${id}/close`).expect('Content-Type', /application\/json/).expect(200);
    expect(closed.body).toEqual({
      pollId: id, status: 'closed', closedAt: expect.any(String), updatedAt: closed.body.closedAt,
      version: 1, totalVotes: 1, ranking: [{ position: 1, option: 'A', votes: 1 }, { position: 2, option: 'B', votes: 0 }],
    });
    await api.post(`/polls/${id}/votes`).set('Content-Type', 'application/json').send('{broken').expect(400)
      .expect(response => checkError(response.body, 'INVALID_VOTE'));
    await fixture.vote(id, 'v').expect(409).expect(response => checkError(response.body, 'POLL_CLOSED'));
    await fixture.vote(id, 'v', 'u', 'unknown').expect(409)
      .expect(response => checkError(response.body, 'POLL_CLOSED'));
    await api.post(`/polls/${id}/close`).expect(200, closed.body);
    await api.get(`/polls/${id}`).expect(200, { ...closed.body, title: 'Linguagens', closesAt: null });
  });
});

describe('limite zero no HTTP', () => {
  const zeroLimit = httpFixture(testRegistry({ maxVotesPerUser: 0 }));
  beforeAll(zeroLimit.start);
  afterAll(zeroLimit.stop);

  it('rejeita o primeiro voto', async () => {
    const id = await zeroLimit.createPoll();
    await zeroLimit.vote(id, 'v').expect(409).expect(response => checkError(response.body, 'USER_VOTE_LIMIT'));
    await zeroLimit.api.get(`/polls/${id}`).expect(response => expect(response.body.totalVotes).toBe(0));
  });
});

describe('concorrência', () => {
  it('deduplica colisões e mantém o limite em votos paralelos', async () => {
    const id = await fixture.createPoll();
    const collisions = await Promise.all(Array.from({ length: 10 }, () => fixture.vote(id, 'same', 'u')));
    expect(collisions.filter(response => response.status === 202)).toHaveLength(1);
    expect(collisions.filter(response => response.status === 200)).toHaveLength(9);
    const responses = await Promise.all([
      ...Array.from({ length: 10 }, () => fixture.vote(id, 'same', 'u')),
      ...Array.from({ length: 10 }, (_, index) => fixture.vote(id, String(index), 'u', 'B')),
    ]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(10);
    expect(responses.filter(response => response.status === 202)).toHaveLength(2);
    expect(responses.filter(response => response.status === 409)).toHaveLength(8);
    await api.get(`/polls/${id}`).expect(200).expect(response => expect(response.body).toMatchObject({
      version: 3, totalVotes: 3,
      ranking: [{ position: 1, option: 'B', votes: 2 }, { position: 2, option: 'A', votes: 1 }],
    }));
  });

  it('retém todos e somente os votos aceitos durante o fechamento', async () => {
    const id = await fixture.createPoll();
    await fixture.vote(id, 'seed').expect(202);
    const requests = Array.from({ length: 40 }, (_, index) => fixture.vote(id, String(index)));
    const [closed, first, last] = await Promise.all([
      api.post(`/polls/${id}/close`).expect(200),
      Promise.all(requests.slice(0, 20)),
      Promise.all(requests.slice(20)),
    ]);
    const votes = [...first, ...last];
    expect(votes.every(vote => [202, 409].includes(vote.status))).toBe(true);
    const accepted = 1 + votes.filter(vote => vote.status === 202).length;
    expect(closed.body).toMatchObject({ totalVotes: accepted, version: accepted,
      ranking: [{ option: 'A', votes: accepted }, { option: 'B', votes: 0 }] });
    await fixture.vote(id, 'late').expect(409);
    await api.get(`/polls/${id}`).expect(200, { ...closed.body, title: 'Linguagens', closesAt: null });
  });
});
