// Small pure helpers shared by the session and its users (no VS Code dependency; unit-tested).

/** A feval result as text (char row, string scalar, or a cell/array of one string). */
export function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') { return v; }
  if (Array.isArray(v) && v.length === 1) { return textOf(v[0]); }
  if (v && typeof v === 'object' && 'value' in v) { return textOf((v as { value: unknown }).value); }
  return v === undefined || v === null ? undefined : String(v);
}

/** A MATLAB single-quoted char literal. */
export function matlabString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
