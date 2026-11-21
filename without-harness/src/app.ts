import express from 'express';
import type { Config } from './config';
import { errorHandler } from './http/error-handler';
import { pollRoutes } from './http/poll-routes';
import { SseConnections } from './http/sse';
import type { RuntimeDependencies } from './polls/poll-runtime';
import { PollService } from './polls/poll-service';
import { PollStore } from './polls/poll-store';

export function createApp(config: Config, dependencies: RuntimeDependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  const store = new PollStore();
  const service = new PollService(store, config, dependencies);
  const connections = new SseConnections();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(pollRoutes(service, connections));
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' }));
  app.use(errorHandler);
  return { app, service, store, connections, dispose: () => { connections.dispose(); store.dispose(); } };
}
