import { describe, expect, it } from 'vitest';
import { validatePoll, validateVote } from '../src/domain/validation';
import { pollBody, voteBody } from './helpers/builders';

describe('poll validation', () => {
  it.each([null, [], 'text', 42, true, undefined, {},
    ...[undefined, 1, '', ' \t\n', 'x'.repeat(201)].map(title => pollBody({ title })),
    ...[[], ['a'], Array.from({ length: 11 }, (_, i) => `${i}`), ['a', 'a'], ['a', 1], ['a', ' '], ['a', 'x'.repeat(101)]].map(options => pollBody({ options })),
    ...[0, 86401, 1.5, '1', true].map(durationSeconds => pollBody({ durationSeconds })),
  ])('rejects invalid body %#', body => {
    expect(() => validatePoll(body)).toThrow(expect.objectContaining({ code: 'INVALID_POLL', status: 400 }));
  });
  it.each([undefined, null, 1, 86400])('accepts duration %s', durationSeconds => {
    expect(validatePoll(pollBody({ durationSeconds })).durationSeconds).toBe(durationSeconds);
  });
  it('accepts exact boundaries and preserves opaque strings and ignores extras', () => {
    const options = ['A', 'a', ' A ', '__proto__', 'x'.repeat(100)];
    expect(validatePoll(pollBody({ title: 'x'.repeat(200), options, extra: 1 })).options).toEqual(options);
    expect(validatePoll(pollBody({ title: 'x', options: ['a', 'b'] })).title).toBe('x');
    expect(validatePoll(pollBody({ options: Array.from({ length: 10 }, (_, i) => `${i}`) })).options).toHaveLength(10);
  });
});

describe('vote validation', () => {
  it.each([null, [], 'text', 1, false, undefined, {},
    ...['voteId', 'userId', 'option'].flatMap(field => [undefined, null, 1, '', ' \t\n'].map(value => ({ ...voteBody(), [field]: value }))),
    { ...voteBody(), voteId: 'x'.repeat(101) }, { ...voteBody(), userId: 'x'.repeat(101) },
  ])('rejects invalid body %#', body => {
    expect(() => validateVote(body)).toThrow(expect.objectContaining({ code: 'INVALID_VOTE', status: 400 }));
  });
  it('preserves exact strings, allows long unknown options, ignores extras', () => {
    const body = { voteId: 'x'.repeat(100), userId: ' __proto__ ', option: 'x'.repeat(101), extra: 1 };
    expect(validateVote(body)).toEqual({ voteId: body.voteId, userId: body.userId, option: body.option });
  });
});
