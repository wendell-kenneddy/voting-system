import { expect, it } from 'vitest';
import { validatePoll, validateVote } from '../../src/domain/validation';

const poll = { title: 'Título', options: ['A', 'B'] };
const vote = { voteId: 'v', userId: 'u', option: 'A' };

it.each([
  undefined, null, false, 5, 'text', [], {},
  { ...poll, title: '' }, { ...poll, title: ' \n\t' }, { ...poll, title: true },
  { ...poll, title: 'x'.repeat(201) },
  { ...poll, options: 'A,B' }, { ...poll, options: ['A'] },
  { ...poll, options: ['A', 'A'] }, { ...poll, options: ['A', ' '] },
  { ...poll, options: ['A', ''] }, { ...poll, options: ['A', 5] },
  { ...poll, options: ['A', 'x'.repeat(101)] },
  { ...poll, options: Array.from({ length: 11 }, (_, i) => String(i)) },
  ...[0, 86401, -1, 1.5, true, '1', NaN, Infinity].map(durationSeconds => ({ ...poll, durationSeconds })),
])('rejeita enquete inválida %#', (payload) => {
  expect(validatePoll(payload)).toEqual({ ok: false, error: 'INVALID_POLL' });
});

it.each([undefined, null, 1, 86400])('aceita duração válida %s e preserva as strings', (durationSeconds) => {
  const payload = {
    title: '😀'.repeat(200), options: ['a', 'A', ' A ', 'x'.repeat(100), 'b', 'c', 'd', 'e', 'f', 'g'],
    durationSeconds,
  };
  expect(validatePoll(payload)).toEqual({ ok: true, value: { ...payload, durationSeconds: durationSeconds ?? null } });
});

it.each([
  undefined, null, false, 5, 'text', [], {},
  { ...vote, voteId: undefined }, { ...vote, voteId: ' ' }, { ...vote, voteId: 'x'.repeat(101) },
  { ...vote, userId: undefined }, { ...vote, userId: '' }, { ...vote, userId: 'x'.repeat(101) },
  { ...vote, userId: 1 }, { ...vote, option: undefined }, { ...vote, option: '\n' },
  { ...vote, option: ['A'] },
])('rejeita voto inválido %#', (payload) => {
  expect(validateVote(payload)).toEqual({ ok: false, error: 'INVALID_VOTE' });
});

it('preserva os três campos e valida pertinência da opção em outra etapa', () => {
  const longOption = { voteId: ' v ', userId: 'x'.repeat(100), option: 'x'.repeat(101) };
  expect(validateVote(longOption)).toEqual({ ok: true, value: longOption });
});
