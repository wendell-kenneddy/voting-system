import { describe, expect, it } from 'vitest';
import { applyVote, closePoll, createPoll } from '../../src/domain/poll';
import { buildRanking } from '../../src/domain/ranking';

const createdAt = '2026-11-20T15:00:00.000Z';
const votedAt = '2026-11-20T15:00:01.000Z';
const closedAt = '2026-11-20T15:00:02.000Z';
const choices = { title: 'Linguagens', options: [' B ', 'a', '__proto__', 'z'], durationSeconds: null };
const firstVote = { voteId: ' voto ', userId: 'Pessoa', option: 'a' };

function makePoll(id = 'id') {
  return createPoll(id, choices, createdAt, null);
}

describe('domínio da enquete', () => {
  it('inicializa todas as opções, posição, versão e horário', () => {
    expect(buildRanking(makePoll())).toEqual({
      pollId: 'id', status: 'open', version: 0, totalVotes: 0, updatedAt: createdAt,
      ranking: choices.options.map((option, index) => ({ position: index + 1, option, votes: 0 })),
    });
  });

  it('ordena por votos e usa a posição declarada em todos os empates', () => {
    const poll = makePoll();
    applyVote(poll, firstVote, votedAt, 3);
    applyVote(poll, { ...firstVote, voteId: 'case', option: '__proto__' }, votedAt, 3);
    const previousRanking = buildRanking(poll);
    expect(previousRanking.ranking).toEqual([
      { position: 1, option: 'a', votes: 1 },
      { position: 2, option: '__proto__', votes: 1 },
      { position: 3, option: ' B ', votes: 0 },
      { position: 4, option: 'z', votes: 0 },
    ]);
    applyVote(poll, { ...firstVote, voteId: 'Case', option: '__proto__' }, closedAt, 3);
    expect(buildRanking(poll)).toMatchObject({
      version: 3, totalVotes: 3, updatedAt: closedAt,
      ranking: [{ position: 1, option: '__proto__', votes: 2 },
        { position: 2, option: 'a', votes: 1 }, { position: 3, option: ' B ', votes: 0 },
        { position: 4, option: 'z', votes: 0 }],
    });
    expect(previousRanking.version).toBe(2);
    expect(previousRanking.ranking[0].option).toBe('a');
  });

  it('aceita, rejeita opção antes de duplicidade e reconhece duplicidade antes do limite', () => {
    const poll = makePoll();
    expect(applyVote(poll, firstVote, votedAt, 1)).toEqual({
      ok: true, value: { status: 'accepted', voteId: firstVote.voteId },
    });
    expect(applyVote(poll, { ...firstVote, option: 'A' }, closedAt, 1))
      .toEqual({ ok: false, error: 'UNKNOWN_OPTION' });
    expect(applyVote(poll, { ...firstVote, option: ' B ' }, closedAt, 1)).toEqual({
      ok: true, value: { status: 'duplicate', voteId: firstVote.voteId },
    });
    expect(applyVote(poll, { ...firstVote, voteId: 'retry' }, closedAt, 1))
      .toEqual({ ok: false, error: 'USER_VOTE_LIMIT' });
    expect(buildRanking(poll)).toMatchObject({ version: 1, totalVotes: 1, updatedAt: votedAt });
  });

  it('isola IDs e limites entre enquetes e usa o identificador original do usuário', () => {
    const poll = makePoll();
    const second = makePoll('second');
    applyVote(poll, firstVote, votedAt, 1);
    expect(applyVote(second, firstVote, votedAt, 1)).toMatchObject({ value: { status: 'accepted' } });
    const retry = { ...firstVote, voteId: 'retry' };
    expect(applyVote(poll, retry, votedAt, 1)).toMatchObject({ error: 'USER_VOTE_LIMIT' });
    expect(applyVote(poll, { ...retry, userId: 'pessoa' }, votedAt, 1))
      .toMatchObject({ value: { status: 'accepted' } });
    expect(applyVote(poll, { ...retry, voteId: 'retry ', userId: ' Pessoa' }, votedAt, 1))
      .toMatchObject({ value: { status: 'accepted' } });
    expect(applyVote(poll, { ...retry, userId: 'terceiro' }, votedAt, 1))
      .toMatchObject({ value: { status: 'duplicate' } });
    expect(applyVote(poll, { ...retry, voteId: 'new', userId: 'terceiro' }, votedAt, 1))
      .toMatchObject({ value: { status: 'accepted' } });
  });

  it('permite configurar zero votos por usuário', () => {
    const poll = makePoll();
    expect(applyVote(poll, firstVote, votedAt, 0)).toMatchObject({ error: 'USER_VOTE_LIMIT' });
    expect(buildRanking(poll).version).toBe(0);
  });

  it('prioriza o fechamento e preserva o primeiro horário de encerramento', () => {
    const poll = makePoll();
    applyVote(poll, firstVote, votedAt, 3);
    closePoll(poll, closedAt);
    closePoll(poll, '2026-11-20T15:00:03.000Z');
    expect(applyVote(poll, firstVote, closedAt, 3)).toEqual({ ok: false, error: 'POLL_CLOSED' });
    expect(buildRanking(poll)).toMatchObject({
      status: 'closed', closedAt, updatedAt: closedAt, totalVotes: 1, version: 1,
    });
  });
});
