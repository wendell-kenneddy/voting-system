export interface Config {
  port: number;
  maxVotesPerUser: number;
  rankingThrottleMs: number;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  return {
    port: integer('PORT', 3000, 1, 65535),
    maxVotesPerUser: integer('MAX_VOTES_PER_USER', 3, 0, Number.MAX_SAFE_INTEGER),
    rankingThrottleMs: integer('RANKING_THROTTLE_MS', 1000, 0, 2_147_483_647),
  };
}
