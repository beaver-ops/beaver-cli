// The CLI's version (kept equal to package.json's: tests/version.test.ts checks it).
export const VERSION = "1.0.0";

/** -1 / 0 / 1 comparing `1.2.3`-style versions (anything after a `-` is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
