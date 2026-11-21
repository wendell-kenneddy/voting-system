import { Router } from 'express';
import type { PollService } from '../polls/poll-service';
import { jsonBody } from './error-handler';
import type { SseConnections } from './sse';

export function pollRoutes(service: PollService, connections: SseConnections): Router {
  const router = Router();
  router.post('/polls', jsonBody('INVALID_POLL'), (req, res) => res.status(201).json(service.create(req.body)));
  router.get('/polls/:pollId', (req, res) => res.json(service.details(req.params.pollId)));
  router.post<{ pollId: string }>('/polls/:pollId/votes', (req, _res, next) => {
    service.store.get(req.params.pollId);
    next();
  }, jsonBody('INVALID_VOTE'), (req, res) => {
    const result = service.vote(req.params.pollId, req.body);
    res.status(result.status === 'accepted' ? 202 : 200).json(result);
  });
  router.get('/polls/:pollId/stream', (req, res) => connections.open(service.current(req.params.pollId), res));
  router.post('/polls/:pollId/close', (req, res) => res.json(service.close(req.params.pollId)));
  return router;
}
