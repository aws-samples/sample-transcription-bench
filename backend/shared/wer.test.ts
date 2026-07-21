import { computeWer, editDistance, normalizeTranscript, tokenize } from './wer';

describe('normalizeTranscript', () => {
  test('lowercases and strips punctuation', () => {
    expect(normalizeTranscript('Hello, World!')).toBe('hello world');
  });

  test('expands common contractions', () => {
    expect(normalizeTranscript("I can't do it")).toBe('i cannot do it');
    expect(normalizeTranscript("They're here")).toBe('they are here');
    expect(normalizeTranscript("I won't go")).toBe('i will not go');
  });

  test('collapses repeated whitespace', () => {
    expect(normalizeTranscript('hello   \n world')).toBe('hello world');
  });
});

describe('tokenize', () => {
  test('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  test('splits on spaces', () => {
    expect(tokenize('the quick brown fox')).toEqual(['the', 'quick', 'brown', 'fox']);
  });
});

describe('editDistance', () => {
  test('identical sequences have distance 0', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
  });

  test('counts substitutions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
  });

  test('counts insertions', () => {
    expect(editDistance(['a', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  test('counts deletions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
  });

  test('handles empty inputs', () => {
    expect(editDistance([], [])).toBe(0);
    expect(editDistance(['a', 'b'], [])).toBe(2);
    expect(editDistance([], ['a', 'b'])).toBe(2);
  });
});

describe('computeWer', () => {
  test('identical transcripts -> 0', () => {
    expect(computeWer('the quick brown fox', 'the quick brown fox')).toBe(0);
  });

  test('matches the AssemblyAI blog example (2 substitutions out of 9 words)', () => {
    const reference = 'The quick brown fox jumps over the lazy dog';
    const hypothesis = 'A quick brown fox jumped over the lazy dog';
    const wer = computeWer(reference, hypothesis);
    expect(wer).toBeCloseTo(2 / 9, 4);
  });

  test('normalization makes punctuation differences a non-issue', () => {
    expect(computeWer('Hello, world!', 'hello world')).toBe(0);
  });

  test('contractions are normalized', () => {
    expect(computeWer("I can't go", 'I cannot go')).toBe(0);
  });

  test('completely different transcripts cap at 1', () => {
    expect(computeWer('alpha beta gamma', 'one two three')).toBe(1);
  });

  test('empty reference + empty hypothesis -> 0', () => {
    expect(computeWer('', '')).toBe(0);
  });

  test('empty reference + non-empty hypothesis -> 1', () => {
    expect(computeWer('', 'something said')).toBe(1);
  });
});
