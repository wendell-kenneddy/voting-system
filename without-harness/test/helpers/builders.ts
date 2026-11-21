export const pollBody = (extra: Record<string, unknown> = {}) => ({ title: 'Languages', options: ['TypeScript', 'Go', 'Rust'], ...extra });
export const voteBody = (voteId = 'v1', userId = 'u1', option = 'TypeScript') => ({ voteId, userId, option });
