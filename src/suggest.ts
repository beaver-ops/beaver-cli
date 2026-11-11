// "Did you mean …": the closest candidate within a small edit distance.

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      // A swap of two neighbours counts as one edit (`conect` / `ocnnect`).
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/** The closest of `candidates` to `input`, or null when none is close (≤ a third of its length, at least 1, at most 3). */
export function suggest(input: string, candidates: string[]): string | null {
  const needle = input.toLowerCase();
  let best: { c: string; d: number } | null = null;
  for (const c of candidates) {
    const d = editDistance(needle, c.toLowerCase());
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return null;
  const max = Math.min(3, Math.max(1, Math.floor(best.c.length / 3)));
  return best.d <= max ? best.c : null;
}
