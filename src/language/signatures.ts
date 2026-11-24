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

// ---------------------------------------------------------------------------------------------------------
// File and folder completion, like the MATLAB desktop's: for an argument that functionSignatures.json declares as a
// file or folder (load, addpath, cd, genpath, readtable, imread, ...), MATLAB lists the matching names in the current
// folder (and files on the path) as the argument's `widgetData.choices`.
// [verified, R2026b] choices come as a struct array, either {mwdata:[{completion, displayString?, matchType}, ...]}
// or column-wise {mwdata:{completion:[...], displayString:[...], matchType:[...]}}. matchType 'folder' | 'filename' |
// 'pathItem' (a file on the path). `completion` replaces the argument from its bounds.left to the cursor: "'dist\"
// (a folder: no closing quote, so the user goes on into it) or "'data.mat'" (a file, closed). The argument's `bounds`
// are offsets in the line.

export interface PathChoice {
  /** Shown in the list: "dist\", "data.mat". */
  label: string;
  /** Replaces the line from `from` to the cursor. */
  insert: string;
  folder: boolean;
}

export interface PathCompletion { from: number; choices: PathChoice[]; }

const PATH_TYPES = new Set(['folder', 'filename', 'pathItem']);

/** A struct array as rows: [{a, b}, ...] from either encoding. */
function rows(v: unknown): Record<string, unknown>[] {
  const md = v && typeof v === 'object' && 'mwdata' in (v as object) ? (v as { mwdata: unknown }).mwdata : v;
  if (md && typeof md === 'object' && !Array.isArray(md)) {
    const o = md as Record<string, unknown>;
    const cols = Object.values(o).filter(Array.isArray) as unknown[][];
    if (cols.length && cols.length === Object.keys(o).length) {   // column-wise: every field is an array
      return cols[0].map((_, i) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, (c as unknown[])[i]])));
    }
  }
  return items(md);
}

/** The file/folder choices MATLAB offers for the argument at the cursor; undefined when it is not such an argument. */
export function parsePathChoices(raw: unknown): PathCompletion | undefined {
  const top = items(raw)[0];
  if (!top) { return undefined; }
  let from: number | undefined;
  const choices: PathChoice[] = [];
  const seen = new Set<string>();
  for (const sig of rows(top.signatures)) {
    for (const arg of rows(sig.inputArguments)) {
      if (arg.status !== 'presenting') { continue; }
      const widget = arg.widgetData as Record<string, unknown> | undefined;
      const list = rows(widget?.choices).filter(c => typeof c.completion === 'string' && PATH_TYPES.has(String(c.matchType)));
      const left = Number((rows(arg.bounds)[0] as { left?: unknown } | undefined)?.left);
      if (!list.length || !Number.isFinite(left)) { continue; }
      if (from === undefined) { from = left; } else if (left !== from) { continue; }
      for (const c of list) {
        const insert = String(c.completion);
        if (seen.has(insert)) { continue; }
        seen.add(insert);
        const shown = str(c.displayString) ?? insert;
        choices.push({ label: shown.replace(/^["']|["']$/g, ''), insert, folder: c.matchType === 'folder' });
      }
    }
  }
  if (from === undefined || !choices.length) { return undefined; }
  // Folders first, like MATLAB; each group in MATLAB's order.
  return { from, choices: [...choices.filter(c => c.folder), ...choices.filter(c => !c.folder)] };
}
