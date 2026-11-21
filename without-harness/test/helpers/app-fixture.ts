import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createApp } from '../../src/app';
import { closeServer } from '../../src/server';
import type { Config } from '../../src/config';
import type { CreatedPoll } from '../../src/domain/types';
import { SseClient } from './sse-client';
import { pollBody, voteBody } from './builders';

export async function createFixture(config: Partial<Config> = {}) {
  const application = createApp({ port: 3000, maxVotesPerUser: 3, rankingThrottleMs: 1000, ...config });
  const server = createServer(application.app);
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { application.dispose(); throw error; }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients = new Set<SseClient>();

  function request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, raw = false, contentType = 'application/json') {
    return new Promise<{ status: number; body: T; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const data = body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);
      const req = httpRequest(`${url}${path}`, { method, headers: { 'Content-Type': contentType } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(text) as T, headers: res.headers }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(4000, () => req.destroy(new Error('HTTP timeout')));
      req.on('error', reject);
      req.end(data);
    });
  }
  return {
    ...application, server, url, request,
    async create(extra: Record<string, unknown> = {}) {
      const result = await request<CreatedPoll>('POST', '/polls', pollBody(extra));
      if (result.status !== 201) throw new Error(`Creation failed: ${JSON.stringify(result)}`);
      return result.body;
    },
    vote(id: string, voteId = 'v1', userId = 'u1', option = 'TypeScript') {
      return request('POST', `/polls/${id}/votes`, voteBody(voteId, userId, option));
    },
    async stream(id: string) {
      const client = new SseClient();
      clients.add(client);
      return client.connect(`${url}/polls/${id}/stream`);
    },
    async cleanup() {
      for (const client of clients) client.close();
      clients.clear();
      await closeServer(server, application.dispose);
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof createFixture>>;
