import type { Express } from 'express';
import type { PollRegistry } from '../../application/pollRegistry';
import { jsonBody, sendError, sendJson } from './errorHandler';
import { sendStream } from './sse';

export function registerRoutes(app: Express, registry: PollRegistry): void {
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

  app.post('/polls', jsonBody('INVALID_POLL'), (req, res) => {
    sendJson(res, registry.create(req.body), 201);
  });

  app.get('/polls/:pollId', (req, res) => {
    sendJson(res, registry.get(req.params.pollId));
  });

  app.post<{ pollId: string }>('/polls/:pollId/votes', (req, res, next) => {
    if (!registry.has(req.params.pollId)) {
      sendError(res, 'POLL_NOT_FOUND');
      return;
    }
    next();
  }, jsonBody('INVALID_VOTE'), (req, res) => {
    sendJson(res, registry.vote(req.params.pollId, req.body), receipt => receipt.status === 'accepted' ? 202 : 200);
  });

  app.get('/polls/:pollId/stream', (req, res) => {
    const stream = registry.stream(req.params.pollId);
    if (!stream.ok) {
      sendError(res, stream.error);
      return;
    }
    sendStream(req, res, stream.value);
  });

  app.post('/polls/:pollId/close', (req, res) => {
    sendJson(res, registry.close(req.params.pollId));
  });
}
