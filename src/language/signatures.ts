// Function signature help like the MATLAB desktop's ("plot(Y,LineSpec,options)  1 of 10", with the current argument's
// purpose and allowed values), from MATLAB's own signature data: matlabls.internal.getCompletions(code, '', offset),
// shipped with the official MATLAB extension and fed by MATLAB's functionSignatures.json files.
// [verified, R2026b + extension 1.3.16] Shape of the result (MATLAB data, cells/struct arrays as {mwdata, mwsize, mwtype}):
//   {signatures: <struct or {mwdata:[struct...]}>}, each struct:
//     {functionName, status?: 'presenting', score?, inputArguments: <struct or {mwdata:[...]}>, outputArguments?}
//   each input argument: {name, kind: 'required'|'optional'|'name'|..., purpose?, valueSummary?, value?, status?}
// No VS Code or DOM dependency; unit-tested.

export interface SignatureParam {
  name: string;
  kind: string;
  /** e.g. "y-coordinates" */
  purpose?: string;
  /** e.g. "scalar | vector | matrix" */
  valueSummary?: string;
}

export interface SignatureForm {
  functionName: string;
  params: SignatureParam[];
  /** Index in params of the argument the cursor is on, or -1. */
  active: number;
  /** "plot(Y,LineSpec,options)" */
  label: string;
}

export interface SignatureHelp {
  forms: SignatureForm[];
}

/** MATLAB data -> plain array: cells and struct arrays come as {mwdata: [...]}, a single struct as an object. */
function items(v: unknown): Record<string, unknown>[] {
  if (v === null || v === undefined) { return []; }
  if (Array.isArray(v)) { return v.flatMap(items); }
  if (typeof v === 'object' && 'mwdata' in (v as object)) { return items((v as { mwdata: unknown }).mwdata); }
  return typeof v === 'object' ? [v as Record<string, unknown>] : [];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Parse the raw result of matlabls.internal.getCompletions; undefined when there are no signatures. */
export function parseSignatures(raw: unknown): SignatureHelp | undefined {
  const top = items(raw)[0];
  if (!top) { return undefined; }
  const forms: SignatureForm[] = [];
  const seen = new Set<string>();
  // [verified] MATLAB ranks the forms with `promotion`: suggested, then primary, then secondary.
  const rank = (s: Record<string, unknown>) => ({ suggested: 0, primary: 1, secondary: 2 } as Record<string, number>)[String(s.promotion)] ?? 1;
  const sigs = items(top.signatures).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
  for (const sig of sigs) {
    const functionName = str(sig.functionName);
    if (!functionName) { continue; }
    const args = items(sig.inputArguments).filter(a => str(a.name));
    let active = args.findIndex(a => a.status === 'presenting');
    // Like the MATLAB desktop: leading optional arguments that have not been typed (e.g. a target axes `ax`) are
    // hidden when a required argument follows; the cursor is then on the first argument that remains.
    let skip = 0;
    while (skip < args.length && args[skip].kind === 'optional' && !str(args[skip].value)
      && args.slice(skip + 1).some(a => a.kind === 'required')) { skip++; }
    const kept = args.slice(skip);
    if (skip > 0) { active = active < skip ? (active >= 0 ? 0 : -1) : active - skip; }
    const params: SignatureParam[] = kept.map(a => ({
      name: String(a.name), kind: String(a.kind ?? ''), purpose: str(a.purpose), valueSummary: str(a.valueSummary),
    }));
    const label = `${functionName}(${params.map(p => p.name).join(',')})`;
    if (seen.has(label)) { continue; }
    seen.add(label);
    forms.push({ functionName, params, active: Math.min(active, params.length - 1), label });
  }
  return forms.length ? { forms } : undefined;
}
