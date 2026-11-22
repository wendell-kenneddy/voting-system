type Environment = Readonly<Record<string, string | undefined>>;

function nonNegativeInteger(env: Environment, name: string, fallback: number, max = Infinity): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Configuração inválida em ${name}. Informe um inteiro entre 0 e ${max}.`);
  }
  return value;
}

export function readConfig(env: Environment) {
  return {
    port: nonNegativeInteger(env, 'PORT', 3000, 65535),
    maxVotesPerUser: nonNegativeInteger(env, 'MAX_VOTES_PER_USER', 3),
    rankingThrottleMs: nonNegativeInteger(env, 'RANKING_THROTTLE_MS', 1000),
  };
}
