/**
 * Pure MATLAB text helpers for the Command Window's input line: which call the cursor is in (for the usage hint)
 * and which identifier is being typed (for completion). No VS Code or DOM dependency; unit-tested.
 * MATLAB rules: `%` starts a comment, `...` continues a line (the rest is a comment), "strings" escape a quote by
 * doubling it (no backslash escapes), and `'` is a transpose after a value.
 */

export interface CallContext {
  /** Function name before the innermost open parenthesis. */
  name: string;
  /** 0-based index of the argument the cursor is in. */
  param: number;
}

const KEYWORDS = new Set(['if', 'elseif', 'while', 'for', 'parfor', 'switch', 'case', 'return', 'function', 'end', 'catch']);

/** Index just after a closing quote, or -1 if the string runs to the end of `s` (the cursor is inside it). */
function closeQuote(s: string, i: number, q: string): number {
  while (i < s.length) {
    if (s[i] === '\n') { return i; }
    if (s[i] === q) { if (s[i + 1] === q) { i += 2; continue; } return i; }
    i++;
  }
  return -1;
}

function isQuoteStart(s: string, i: number): boolean {
  if (s[i] === '"') { return true; }
  if (s[i] !== "'") { return false; }
  const prev = i > 0 ? s[i - 1] : '';
  return !/[\w)\]}'.]/.test(prev);
}

/**
 * Find the call the cursor is in. `text` is the code before the cursor. Strings and comments are skipped;
 * brackets nest. Undefined inside a string, a comment, or [] / {} of an argument.
 */
export function callContext(text: string): CallContext | undefined {
  interface Open { ch: string; pos: number; commas: number; }
  const stack: Open[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '%' || text.startsWith('...', i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { return undefined; }
      i = nl + 1;
      continue;
    }
    if (isQuoteStart(text, i)) {
      const end = closeQuote(text, i + 1, c);
      if (end < 0) { return undefined; }
      i = end + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { stack.push({ ch: c, pos: i, commas: 0 }); }
    else if (c === ')' || c === ']' || c === '}') { stack.pop(); }
    else if (c === ',' && stack.length) { stack[stack.length - 1].commas++; }
    i++;
  }
  const o = stack[stack.length - 1];
  if (!o || o.ch !== '(') { return undefined; }
  const m = /(?:^|[^\w.])([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)\s*$/.exec(text.slice(0, o.pos));
  if (m && !KEYWORDS.has(m[1])) { return { name: m[1], param: o.commas }; }
  return undefined;
}

export interface CompletionPrefix {
  /** Full dotted prefix, e.g. "s.na" or "pl" (may be ""). */
  prefix: string;
  /** Column where the last segment (the part being replaced) starts. */
  segmentStart: number;
}

/** The identifier (possibly dotted) being typed at the end of `linePrefix`; undefined in strings/comments/numbers. */
export function completionPrefix(linePrefix: string): CompletionPrefix | undefined {
  if (inStringOrComment(linePrefix)) { return undefined; }
  const m = /(?:^|[^\w.])((?:[A-Za-z]\w*\.)*[A-Za-z]?\w*)$/.exec(linePrefix);
  if (!m) { return undefined; }
  const prefix = m[1];
  if (/^\d/.test(prefix)) { return undefined; }
  const lastDot = prefix.lastIndexOf('.');
  return { prefix, segmentStart: linePrefix.length - prefix.length + lastDot + 1 };
}

function inStringOrComment(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' || s.startsWith('...', i)) { return true; }
    if (isQuoteStart(s, i)) {
      const end = closeQuote(s, i + 1, s[i]);
      if (end < 0) { return true; }
      i = end + 1;
      continue;
    }
    i++;
  }
  return false;
}

/** Where an unterminated string starts in `s` (the cursor is inside it), or -1 (also -1 in a comment). */
function openStringStart(s: string): number {
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' || s.startsWith('...', i)) { return -1; }
    if (isQuoteStart(s, i)) {
      const end = closeQuote(s, i + 1, s[i]);
      if (end < 0) { return i; }
      i = end + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Whether the cursor (end of `linePrefix`) may be in a file or folder argument, so that MATLAB's own completion is
 * asked for paths: in a quoted argument of a call (`load('da`, `addpath(p, "src\`), or in an argument of command
 * syntax (`cd ..\da`, `load data`). MATLAB's function signatures decide whether it really is one.
 */
export function maybePathArgument(linePrefix: string): boolean {
  const q = openStringStart(linePrefix);
  if (q >= 0) {
    const before = linePrefix.slice(0, q);
    return /[(,]\s*$/.test(before) && !!callContext(before);
  }
  if (inStringOrComment(linePrefix)) { return false; }
  const m = /^\s*([A-Za-z]\w*)\s+(?![=(]|[-+*/^<>&|~]=?\s)(\S*\s+)*\S*$/.exec(linePrefix);
  return !!m && !KEYWORDS.has(m[1]) && !/^(else|end|try|otherwise|break|continue)$/.test(m[1]);
}

/** The name at `col`, unless it is in a comment or string, a field (s.name) or a number. Pure; unit-tested. */
export function hoverName(line: string, col: number): { name: string; start: number; end: number } | undefined {
  // Walk the line once: skip strings ('…' or "…", '' / "" escapes; ' after a name, ) ] } . or ' is transpose) and stop
  // at a comment.
  const re = /[A-Za-z_]\w*/y;
  let prev = '';
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === '%' || (c === '.' && line.startsWith('...', i))) { return undefined; }   // comment or continuation: no names after it
    if (c === '"' || (c === "'" && !/[\w)\]}.']/.test(prev))) {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === c) { if (line[j + 1] === c) { j++; continue; } break; }
      }
      if (col >= i && col <= j) { return undefined; }
      prev = c; i = j + 1; continue;
    }
    re.lastIndex = i;
    const m = /[A-Za-z_]/.test(c) && !/\d/.test(prev) ? re.exec(line) : null;
    if (m) {
      const end = i + m[0].length;
      if (col >= i && col <= end) { return prev === '.' ? undefined : { name: m[0], start: i, end }; }
      prev = line[end - 1]; i = end; continue;
    }
    prev = c.trim() ? c : ' ';
    i++;
  }
  return undefined;
}
