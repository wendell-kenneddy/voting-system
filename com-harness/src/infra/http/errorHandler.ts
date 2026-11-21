import { json, type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import type { ErrorCode, Result } from '../../domain/errors';

const errors: Record<ErrorCode, { status: number; message: string }> = {
  INVALID_POLL: { status: 400, message: 'Corpo da enquete inválido.' },
  INVALID_VOTE: { status: 400, message: 'Corpo do voto inválido.' },
  POLL_NOT_FOUND: { status: 404, message: 'Enquete inexistente.' },
  POLL_CLOSED: { status: 409, message: 'Enquete encerrada.' },
  UNKNOWN_OPTION: { status: 422, message: 'A opção não pertence à enquete.' },
  USER_VOTE_LIMIT: { status: 409, message: 'Limite de votos do usuário atingido.' },
};

export function sendError(res: Response, error: ErrorCode): void {
  const { status, message } = errors[error];
  res.status(status).json({ error, message });
}

export function sendJson<T>(res: Response, result: Result<T>, status: number | ((value: T) => number) = 200): void {
  if (!result.ok) {
    sendError(res, result.error);
    return;
  }
  const code = typeof status === 'function' ? status(result.value) : status;
  res.status(code).json(result.value);
}

export function jsonBody(error: 'INVALID_POLL' | 'INVALID_VOTE'): RequestHandler {
  const parser = json({ strict: false });
  return (req, res, next) => {
    parser(req, res, (cause?: unknown) => {
      if (cause) {
        sendError(res, error);
      } else {
        next();
      }
    });
  };
}

export const handleUnexpected: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Falha interna do servidor.' });
};
