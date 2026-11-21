import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

describe('configuration', () => {
  it('uses defaults and preserves business zeros', () => {
    expect(readConfig({})).toEqual({ port: 3000, maxVotesPerUser: 3, rankingThrottleMs: 1000 });
    expect(readConfig({ PORT: '4321', MAX_VOTES_PER_USER: '0', RANKING_THROTTLE_MS: '0' }))
      .toEqual({ port: 4321, maxVotesPerUser: 0, rankingThrottleMs: 0 });
    expect(readConfig({ MAX_VOTES_PER_USER: '9', RANKING_THROTTLE_MS: '250' })).toMatchObject({ maxVotesPerUser: 9, rankingThrottleMs: 250 });
  });
  for (const name of ['PORT', 'MAX_VOTES_PER_USER', 'RANKING_THROTTLE_MS']) {
    it.each(['', ' ', '-1', '1.2', '12ms', 'Infinity', 'NaN', '1e3', '9007199254740992'])(`rejects ${name}=%s`, value => {
      expect(() => readConfig({ [name]: value })).toThrow(name);
    });
  }
  it('enforces port and timer bounds', () => {
    for (const PORT of ['0', '65536']) expect(() => readConfig({ PORT })).toThrow('PORT');
    expect(() => readConfig({ RANKING_THROTTLE_MS: '2147483648' })).toThrow('RANKING_THROTTLE_MS');
    expect(readConfig({ PORT: '65535', RANKING_THROTTLE_MS: '2147483647', MAX_VOTES_PER_USER: '9007199254740991' }).port).toBe(65535);
  });
});
