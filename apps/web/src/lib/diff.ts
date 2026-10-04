export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** Line diff via LCS. Falls back to delete-all/add-all for very large inputs. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  if (A.length * B.length > 4_000_000) {
    return [...A.map((text) => ({ op: "del" as const, text })), ...B.map((text) => ({ op: "add" as const, text }))];
  }
  const n = A.length, m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: "same", text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "del", text: A[i++]! });
    else out.push({ op: "add", text: B[j++]! });
  }
  while (i < n) out.push({ op: "del", text: A[i++]! });
  while (j < m) out.push({ op: "add", text: B[j++]! });
  return out;
}
