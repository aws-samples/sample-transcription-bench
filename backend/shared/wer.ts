/**
 * Word Error Rate (WER) computation.
 *
 * Implements the standard reference / hypothesis comparison after a
 * lightweight Whisper-style normalization (lowercase, strip punctuation,
 * expand common contractions, collapse whitespace). Returns a value in
 * [0, +∞), capped at 1.0 in the metric — values above 1 indicate the
 * hypothesis has more errors than reference words (typical for very bad
 * outputs) and we clamp them so the UI stays sane.
 *
 * No external dependencies. Edit-distance is computed with the standard
 * O(N×M) Wagner-Fischer DP. Inputs are expected to be a few thousand
 * tokens at most (audio under 5 minutes), so memory/time are not a concern.
 */

const CONTRACTIONS: Record<string, string> = {
  "won't": 'will not',
  "can't": 'cannot',
  "n't": ' not',
  "'re": ' are',
  "'s": ' is',
  "'d": ' would',
  "'ll": ' will',
  "'ve": ' have',
  "'m": ' am',
};

/**
 * Normalize a transcript for fair WER comparison.
 *  - Lowercase
 *  - Expand a small set of common English contractions
 *  - Strip punctuation (keep alphanumerics, spaces, hyphens inside words)
 *  - Collapse whitespace
 */
export function normalizeTranscript(text: string): string {
  let out = text.toLowerCase();

  // Expand contractions before punctuation stripping (we need the apostrophes).
  for (const [pattern, replacement] of Object.entries(CONTRACTIONS)) {
    out = out.split(pattern).join(replacement);
  }

  // Replace any remaining punctuation/symbols with a single space.
  // Keeps word characters (incl. unicode letters), digits, hyphens, and spaces.
  out = out.replace(/[^\p{L}\p{N}\s-]/gu, ' ');

  // Collapse repeated whitespace.
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}

/**
 * Tokenize a normalized transcript into words.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text.split(' ').filter((t) => t.length > 0);
}

/**
 * Wagner-Fischer edit distance between two token arrays.
 * Returns the minimum number of insertions + deletions + substitutions.
 */
export function editDistance(ref: readonly string[], hyp: readonly string[]): number {
  const n = ref.length;
  const m = hyp.length;
  if (n === 0) return m;
  if (m === 0) return n;

  // Single-row DP buffer to keep memory at O(min(n, m)).
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution / match
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

/**
 * Compute Word Error Rate of `hypothesis` against `reference` after
 * normalizing both. Returns a value in [0, 1] (clamped).
 *
 * Empty reference: returns 0 if hypothesis is also empty, otherwise 1
 * (treating any output against an empty reference as 100% error).
 */
export function computeWer(reference: string, hypothesis: string): number {
  const refTokens = tokenize(normalizeTranscript(reference));
  const hypTokens = tokenize(normalizeTranscript(hypothesis));

  if (refTokens.length === 0) {
    return hypTokens.length === 0 ? 0 : 1;
  }

  const distance = editDistance(refTokens, hypTokens);
  const wer = distance / refTokens.length;
  return Math.min(1, wer);
}
