/** Simple unified-style line diff (pure, small inputs). */
export function diffLines(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: string[] = [];
  const n = al.length, m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${al[i]}`); i++; }
    else { out.push(`+${bl[j]}`); j++; }
  }
  while (i < n) { out.push(`-${al[i]}`); i++; }
  while (j < m) { out.push(`+${bl[j]}`); j++; }
  return out.join("\n");
}

export function levenshtein(a: string, b: string, cap = 400): number {
  if (Math.abs(a.length - b.length) > cap) return cap;
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap;
    prev = cur;
  }
  return prev[m];
}

/** Above this combined length editCost uses the length delta instead of a full Levenshtein distance. */
const LEVENSHTEIN_MAX_TOTAL_LENGTH = 6000;

export function editCost(a: string, b: string): number {
  const al = a.split("\n"), bl = b.split("\n");
  let changedLines = Math.abs(al.length - bl.length);
  const n = Math.min(al.length, bl.length);
  for (let i = 0; i < n; i++) if (al[i] !== bl[i]) changedLines++;
  const charCost = a.length + b.length > LEVENSHTEIN_MAX_TOTAL_LENGTH ? Math.abs(a.length - b.length) : levenshtein(a, b);
  return changedLines * 4 + Math.min(charCost, 200);
}
