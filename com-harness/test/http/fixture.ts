import { once } from 'node:events';
import { createServer, get, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { PollRegistry } from '../../src/application/pollRegistry';
import { createApp } from '../../src/infra/http/app';
import { nodeScheduler, systemClock } from '../../src/main';

const pollBody = { title: 'Linguagens', options: ['A', 'B'] };

export function testRegistry(options: Partial<ConstructorParameters<typeof PollRegistry>[0]> = {}): PollRegistry {
  let id = 0;
  return new PollRegistry({
    clock: systemClock, ids: { next: () => `poll-${id++}` },
    scheduler: nodeScheduler, rankingThrottleMs: 1_000, maxVotesPerUser: 3,
    ...options,
  });
}

export type SseFrame =
  | { kind: 'heartbeat'; receivedAt: number }
  | { kind: 'ranking' | 'closed'; id: number; data: unknown; receivedAt: number };

class SseClient {
  private readonly reader: AsyncIterator<unknown>;
  private buffer = '';

  constructor(readonly response: IncomingMessage) {
    response.setEncoding('utf8');
    this.reader = response[Symbol.asyncIterator]();
  }

  async next(): Promise<SseFrame | null> {
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary < 0) {
      const chunk = await this.reader.next();
      if (chunk.done) {
        if (this.buffer.length > 0) throw new Error('Frame SSE incompleto.');
        return null;
      }
      if (typeof chunk.value !== 'string') throw new Error('Chunk SSE sem codificação de texto.');
      this.buffer += chunk.value;
      boundary = this.buffer.indexOf('\n\n');
    }

    const raw = this.buffer.slice(0, boundary);
    this.buffer = this.buffer.slice(boundary + 2);
    const receivedAt = performance.now();
    if (raw === ': heartbeat') return { kind: 'heartbeat', receivedAt };
    const lines = /^id: (\d+)\nevent: (ranking|closed)\ndata: (.+)$/.exec(raw);
    if (!lines) throw new Error(`Frame SSE inválido: ${raw}`);
    const kind = lines[2] === 'ranking' ? 'ranking' : 'closed';
    return { kind, id: Number(lines[1]), data: JSON.parse(lines[3]), receivedAt };
  }

  close(): void {
    this.response.destroy();
  }
}

export function httpFixture(registry = testRegistry()) {
  const server = createServer(createApp(registry));
  const api = request(server);
  const clients = new Set<SseClient>();
  let baseUrl: string;

  return {
    api,
    async start() {
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Servidor sem porta TCP.');
      baseUrl = `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      for (const client of clients) client.close();
      clients.clear();
      registry.dispose();
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
    async createPoll(body: object = pollBody): Promise<string> {
      const result = await api.post('/polls').send(body).expect(201);
      const id: unknown = result.body.id;
      if (typeof id !== 'string') throw new Error('A criação não retornou um ID.');
      return id;
    },
    vote(id: string, voteId: string, userId = voteId, option = 'A') {
      return api.post(`/polls/${id}/votes`).send({ voteId, userId, option });
    },
    async connect(id: string): Promise<SseClient> {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(`${baseUrl}/polls/${id}/stream`, resolve).once('error', reject);
      });
      const client = new SseClient(response);
      clients.add(client);
      response.once('close', () => { clients.delete(client); });
      return client;
    },
  };
}
