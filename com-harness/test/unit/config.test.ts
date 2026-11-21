import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config';

describe('configuração', () => {
  it('aplica os padrões', () => {
    expect(readConfig({})).toEqual({ port: 3000, maxVotesPerUser: 3, rankingThrottleMs: 1000 });
  });

  it('preserva os limites zero e converte a porta', () => {
    expect(readConfig({ PORT: '4321', MAX_VOTES_PER_USER: '0', RANKING_THROTTLE_MS: '0' }))
      .toEqual({ port: 4321, maxVotesPerUser: 0, rankingThrottleMs: 0 });
  });

  it.each([
    ['MAX_VOTES_PER_USER', '-1'],
    ['RANKING_THROTTLE_MS', '1.1'],
    ['RANKING_THROTTLE_MS', 'NaN'],
    ['PORT', '65536'],
  ])('rejeita %s=%s', (name, value) => {
    expect(() => readConfig({ [name]: value })).toThrow(name);
  });
});
