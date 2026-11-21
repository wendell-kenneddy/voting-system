import type { ErrorRequestHandler, RequestHandler } from 'express';
import { json } from 'express';
import { DomainError, type ErrorCode } from '../domain/errors';

export function jsonBody(code: Extract<ErrorCode, 'INVALID_POLL' | 'INVALID_VOTE'>): RequestHandler {
  const parse = json({ strict: false, limit: '1mb' });
  return (req, res, next) => parse(req, res, (error?: unknown) => {
    next(error ? new DomainError(400, code, 'Body must contain valid JSON within the 1 MiB limit') : undefined);
  });
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error' });
};
