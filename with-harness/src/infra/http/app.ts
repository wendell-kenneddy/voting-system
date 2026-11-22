import express from 'express';
import type { PollRegistry } from '../../application/pollRegistry';
import { handleUnexpected } from './errorHandler';
import { registerRoutes } from './routes';

export function createApp(registry: PollRegistry) {
  const app = express();
  registerRoutes(app, registry);
  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Rota inexistente.' });
  });
  app.use(handleUnexpected);
  return app;
}
