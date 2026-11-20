// A small CodeMirror stream tokenizer for MATLAB (input line and echoed commands). Written for this extension;
// CodeMirror's legacy modes only have an Octave mode, which treats `#` as a comment and `!` as an operator.
import type { StreamParser, StringStream } from '@codemirror/language';

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'classdef', 'continue', 'else', 'elseif', 'end', 'for', 'function', 'global', 'if',
  'otherwise', 'parfor', 'persistent', 'return', 'spmd', 'switch', 'try', 'while', 'arguments', 'properties',
  'methods', 'events', 'enumeration',
]);
const BUILTINS = new Set([
  'abs', 'all', 'any', 'cell', 'cellfun', 'clc', 'clear', 'close', 'disp', 'double', 'error', 'eval', 'exist',
  'false', 'figure', 'find', 'fprintf', 'hold', 'inf', 'Inf', 'input', 'isempty', 'length', 'linspace', 'max',
  'mean', 'min', 'NaN', 'nan', 'numel', 'ones', 'pi', 'plot', 'rand', 'randn', 'repmat', 'reshape', 'size',
  'sprintf', 'sqrt', 'strcat', 'string', 'struct', 'sum', 'true', 'warning', 'zeros', 'eps', 'keyboard', 'pause',
  'dbstop', 'dbcont', 'dbquit', 'dbstep', 'which', 'help', 'doc', 'cd', 'pwd', 'ans',
]);

interface State { blockComment: number; afterValue: boolean; }

export const matlabStreamParser: StreamParser<State> = {
  name: 'matlab',
  startState: () => ({ blockComment: 0, afterValue: false }),
  token(stream: StringStream, state: State): string | null {
    // %{ ... %} block comments: markers alone on their line.
    if (stream.sol()) {
      const line = stream.string.trim();
      if (line === '%{') { state.blockComment++; stream.skipToEnd(); return 'comment'; }
      if (state.blockComment > 0) {
        if (line === '%}') { state.blockComment--; }
        stream.skipToEnd();
        return 'comment';
      }
    }
    if (stream.eatSpace()) { return null; }
    const afterValue = state.afterValue;
    state.afterValue = false;
    if (stream.match('...')) { stream.skipToEnd(); return 'comment'; }   // continuation: rest is a comment
    const ch = stream.peek()!;
    if (ch === '%') { stream.skipToEnd(); return 'comment'; }
    if (ch === '"') {
      stream.next();
      while (!stream.eol()) {
        const c = stream.next();
        if (c === '"') { if (stream.peek() === '"') { stream.next(); continue; } break; }
      }
      state.afterValue = true;
      return 'string';
    }
    if (ch === "'") {
      if (afterValue) { stream.next(); state.afterValue = true; return 'operator'; }   // transpose
      stream.next();
      while (!stream.eol()) {
        const c = stream.next();
        if (c === "'") { if (stream.peek() === "'") { stream.next(); continue; } break; }
      }
      state.afterValue = true;
      return 'string';
    }
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ij]?/)) { state.afterValue = true; return 'number'; }
    if (stream.match(/^[A-Za-z]\w*/)) {
      const word = stream.current();
      state.afterValue = true;
      if (KEYWORDS.has(word)) { state.afterValue = word === 'end'; return 'keyword'; }
      if (BUILTINS.has(word)) { return 'builtin'; }
      return 'variable';
    }
    if (/[)\]}]/.test(ch)) { stream.next(); state.afterValue = true; return 'bracket'; }
    if (/[([{]/.test(ch)) { stream.next(); return 'bracket'; }
    if (ch === '.' && stream.match(".'")) { state.afterValue = true; return 'operator'; }
    if (stream.match(/^(?:==|~=|<=|>=|&&|\|\||\.\*|\.\/|\.\^|\.\\|[-+*/\\^<>=&|~:,;@!])/)) { return 'operator'; }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '%' } },
};
