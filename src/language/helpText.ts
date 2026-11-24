/**
 * Turn MATLAB's help text into usage lines and a one-line description (for the help tooltip, the usage hint and
 * the MCP help tool). Pure; unit-tested. Two formats exist:
 *   R2023a-style:  " zeros - Create array of all zeros\n ... \n    Syntax\n      X = zeros\n      X = zeros(n)\n\n"
 *   classic/user:  " ZEROS  Zeros array.\n    ZEROS(N) is an N-by-N matrix of zeros.\n"  (H1 line + text)
 * The exact layout of help text through the language server is UNVERIFIED (spike check S10).
 */

export interface HelpInfo {
  /** Usage forms, e.g. "X = zeros(n)". */
  signatures: string[];
  /** One-line description (the H1 line without the name). */
  doc: string;
  /** Defining file, when `which` names an existing file. */
  file?: string;
  /** MathWorks documentation page, for functions that ship with MATLAB or a toolbox. */
  docUrl?: string;
}

/** Strip MATLAB hyperlinks/markup from help text. */
export function plainHelp(text: string): string {
  return text.replace(/<a\s+href\s*=\s*"[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1').replace(/<\/?(?:strong|b)>/g, '').replace(/\r\n/g, '\n');
}

/** `whichText`: what which(name) returned. `help`: what help(name) returned. */
export function parseHelp(name: string, whichText: string, help: string, fileText?: string): HelpInfo | undefined {
  const text = plainHelp(help ?? '');
  const lines = text.split('\n');
  const file = fileFromWhich(whichText);
  if (!text.trim() && !file) { return undefined; }
  const short = name.split('.').pop()!;
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Description: the first non-empty line, without the leading name and " - ".
  const first = lines.find(l => l.trim()) ?? '';
  const doc = first.trim().replace(new RegExp(`^${esc}\\s*(?:-\\s+|\\s{2,}|\\s+(?=[A-Z]))`, 'i'), '').trim();

  const signatures: string[] = [];
  const add = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    if (t && !signatures.includes(t)) { signatures.push(t); }
  };
  // "Syntax" section (newer help): indented lines until the next blank line after at least one entry.
  const syn = lines.findIndex(l => /^\s*Syntax\s*$/.test(l));
  if (syn >= 0) {
    for (let i = syn + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { if (signatures.length) { break; } continue; }
      if (/^\s*(Input Arguments|Output Arguments|Description|Examples|See also)\b/.test(l)) { break; }
      add(l);
    }
  }
  if (!signatures.length) {
    // Classic help: lines in the first part that look like a call of NAME (often in upper case).
    const call = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*=\\s*|[A-Za-z]\\w*\\s*=\\s*)?${esc}\\s*\\(`, 'i');
    for (const l of lines.slice(1, 40)) {
      const m = call.exec(l);
      if (!m) { continue; }
      const close = l.indexOf(')', m.index + m[0].length - 1);
      if (close > 0) { add(l.slice(0, close + 1)); }
      if (signatures.length >= 8) { break; }
    }
  }
  if (!signatures.length && fileText) {
    const decl = functionDeclaration(fileText, short);
    if (decl) { add(decl); }
  }
  return { signatures, doc, file, docUrl: docUrlFromWhich(name, whichText) };
}

/** which() output: a path, "built-in (path)", "x is a variable.", or ''. */
export function fileFromWhich(w: string): string | undefined {
  const t = (w ?? '').trim();
  const builtIn = /^built-in \((.*)\)$/.exec(t);
  const p = builtIn ? builtIn[1] : t;
  if (/^[A-Za-z]:[\\/].*\.(m|mlx)$/i.test(p) || /^\/.*\.(m|mlx)$/.test(p)) { return p; }
  return undefined;
}

/**
 * The MathWorks documentation page of a function that ships with MATLAB or a toolbox: which() names a file (or a
 * built-in) under <matlabroot>/toolbox/<product>/, and the page is help/<product>/ref/<name>.html. Nothing for user
 * functions, methods (a.b) or MATLAB's shared/internal folders.
 */
export function docUrlFromWhich(name: string, whichText: string): string | undefined {
  if (!/^[A-Za-z]\w*$/.test(name)) { return undefined; }
  const t = (whichText ?? '').trim().replace(/^built-in \((.*)\)$/, '$1');
  const m = /(?:[\\/]R20\d\d[ab]|MATLAB_R20\d\d[ab]\.app)[\\/]toolbox[\\/](\w+)[\\/]/i.exec(t);
  if (!m || /^(shared|local|internal)$/i.test(m[1]) || /[\\/](private|\+\w+|@\w+)[\\/]/.test(t)) { return undefined; }
  return `https://www.mathworks.com/help/${m[1].toLowerCase()}/ref/${name.toLowerCase()}.html`;
}

/** "function [a, b] = name(x, y)" -> "[a, b] = name(x, y)" for the function called `name` (or the first one). */
export function functionDeclaration(fileText: string, name: string): string | undefined {
  const re = /^\s*function\s+(.+?)\s*(?:%.*)?$/gm;
  let first: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileText))) {
    const decl = m[1].replace(/\.\.\..*$/, '').trim();
    first ??= decl;
    const fn = /(?:=\s*)?([A-Za-z]\w*)\s*(?:\(|$)/.exec(decl.replace(/^\[[^\]]*\]|^[A-Za-z]\w*\s*(?==)/, ''));
    if (fn?.[1] === name) { return decl; }
  }
  return first;
}
