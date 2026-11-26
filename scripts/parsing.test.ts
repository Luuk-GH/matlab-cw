// Unit checks for the pure MATLAB text helpers: input-line syntax, MATLAB hyperlinks, help text, feval results,
// completion items and the Workspace JSON. No VS Code, no MATLAB. Run: npm run test:unit
import * as assert from 'assert';
import { completionItems, fevalOutputs, inputPromptText } from '../src/backend/lsBackend';

assert.strictEqual(inputPromptText(['Enter a number: ']), 'Enter a number: ');
assert.strictEqual(inputPromptText('Name: '), 'Name: ');
assert.strictEqual(inputPromptText({ promptString: 'x? ' }), 'x? ');
assert.strictEqual(inputPromptText(undefined), '');
import { classifyErrLines, hideHelperFrames, linkTarget, parseAnchors } from '../src/commandWindow/webview/anchors';
import { fileFromWhich, functionDeclaration, parseHelp } from '../src/language/helpText';
import { callContext, completionPrefix } from '../src/language/matlabSyntax';
import { matlabString, textOf } from '../src/sessionText';

// ---- callContext / completionPrefix (MATLAB rules) ----
assert.deepStrictEqual(callContext('zeros(3, '), { name: 'zeros', param: 1 });
assert.deepStrictEqual(callContext('x = linspace(0, max(a), '), { name: 'linspace', param: 2 });
assert.deepStrictEqual(callContext('plot(x, y'), { name: 'plot', param: 1 });
assert.strictEqual(callContext("disp('a(b"), undefined, 'inside a char literal');
assert.strictEqual(callContext('disp("x(y'), undefined, 'inside a string literal');
assert.strictEqual(callContext('f(1) % g('), undefined, 'inside a comment');
assert.deepStrictEqual(callContext("f(a', "), { name: 'f', param: 1 }, "transpose is not a quote");
assert.deepStrictEqual(callContext('f("it""s", '), { name: 'f', param: 1 }, 'doubled quote in a string');
assert.strictEqual(callContext('if ('), undefined, 'keyword');
assert.deepStrictEqual(callContext('pkg.fun(1, '), { name: 'pkg.fun', param: 1 });
assert.strictEqual(callContext('x = [1 2 '), undefined);
assert.deepStrictEqual(completionPrefix('s.na'), { prefix: 's.na', segmentStart: 2 });
assert.deepStrictEqual(completionPrefix('x = lin'), { prefix: 'lin', segmentStart: 4 });
assert.strictEqual(completionPrefix("disp('lin"), undefined);
assert.strictEqual(completionPrefix('% lin'), undefined);
assert.strictEqual(completionPrefix('x = 12'), undefined);
assert.strictEqual(completionPrefix('a = b ... lin'), undefined, 'after ... the rest is a comment');

// ---- MATLAB hyperlinks ----
{
  const raw = "Error in <a href=\"matlab:matlab.lang.internal.introspective.errorDocCallback('myfun', 'C:\\work\\myfun.m', 12)\" style=\"font-weight:bold\">myfun</a> (<a href=\"matlab: opentoline('C:\\work\\myfun.m',12,0)\">line 12</a>)\n";
  const r = parseAnchors(raw);
  assert.strictEqual(r.text, 'Error in myfun (line 12)\n');
  assert.deepStrictEqual(r.links, [
    { file: 'C:\\work\\myfun.m', line: 12, start: 9, end: 14 },
    { file: 'C:\\work\\myfun.m', line: 12, start: 16, end: 23 },
  ]);
  assert.deepStrictEqual(parseAnchors('plain text'), { text: 'plain text', links: [] });
  assert.deepStrictEqual(parseAnchors('<strong>zeros</strong> - Create array').text, 'zeros - Create array');
  assert.deepStrictEqual(linkTarget("matlab:opentoline('C:\\it''s\\f.m', 3)"), { file: "C:\\it's\\f.m", line: 3 });
  assert.deepStrictEqual(linkTarget("matlab:helpPopup('zeros')"), undefined);
  assert.deepStrictEqual(linkTarget("matlab:edit('mean_of')"), { func: 'mean_of' });
  const other = parseAnchors('see <a href="matlab:doc zeros">doc zeros</a>.');
  assert.deepStrictEqual(other, { text: 'see doc zeros.', links: [] });
}

// ---- help text ----
{
  const newStyle = ' zeros - Create array of all zeros\n    This MATLAB function returns the scalar 0.\n\n    Syntax\n      X = zeros\n      X = zeros(n)\n      X = zeros(sz1,...,szN)\n\n    Input Arguments\n';
  const h = parseHelp('zeros', 'built-in (C:\\Program Files\\MATLAB\\R2025b\\toolbox\\matlab\\elmat\\zeros)', newStyle)!;
  assert.deepStrictEqual(h.signatures, ['X = zeros', 'X = zeros(n)', 'X = zeros(sz1,...,szN)']);
  assert.strictEqual(h.doc, 'Create array of all zeros');
  assert.strictEqual(h.file, undefined, 'built-ins have no m-file link');
  const classic = ' LINSPACE Linearly spaced vector.\n    LINSPACE(X1, X2) generates a row vector of 100 linearly\n    LINSPACE(X1, X2, N) generates N points between X1 and X2.\n';
  const l = parseHelp('linspace', 'C:\\MATLAB\\toolbox\\matlab\\elmat\\linspace.m', classic)!;
  assert.deepStrictEqual(l.signatures, ['LINSPACE(X1, X2)', 'LINSPACE(X1, X2, N)']);
  assert.strictEqual(l.doc, 'Linearly spaced vector.');
  assert.strictEqual(l.file, 'C:\\MATLAB\\toolbox\\matlab\\elmat\\linspace.m');
  const user = parseHelp('mean_of', 'C:\\w\\mean_of.m', 'MEAN_OF  Mean of the elements of X.\n', 'function m = mean_of(x)\n%MEAN_OF ...\n')!;
  assert.deepStrictEqual(user.signatures, ['m = mean_of(x)']);
  assert.strictEqual(user.doc, 'Mean of the elements of X.');
  assert.strictEqual(parseHelp('nothing', '', ''), undefined);
  assert.strictEqual(fileFromWhich('x is a variable.'), undefined);
  assert.strictEqual(fileFromWhich('/opt/matlab/toolbox/f.m'), '/opt/matlab/toolbox/f.m');
  assert.strictEqual(functionDeclaration('function [a, b] = two(x)\nend\nfunction one\nend', 'one'), 'one');
  assert.strictEqual(functionDeclaration('function [a, b] = two(x) % doc\nend', 'two'), '[a, b] = two(x)');
  const linked = parseHelp('zeros', '', ' <strong>zeros</strong> - Create array of all zeros\n')!;
  assert.strictEqual(linked.doc, 'Create array of all zeros');
}

// ---- feval results and completion items (shapes read from typings, see RESEARCH.md) ----
assert.deepStrictEqual(fevalOutputs({ result: ['a', 2] }), ['a', 2]);
assert.deepStrictEqual(fevalOutputs({ result: 'a' }), ['a']);
assert.deepStrictEqual(fevalOutputs(['x']), ['x']);
assert.deepStrictEqual(fevalOutputs('x'), ['x']);
assert.deepStrictEqual(fevalOutputs(null), []);
assert.deepStrictEqual(completionItems({ items: [{ label: 'x', kind: 6 }, { label: 'f', kind: 5 }, { label: 'for', kind: 14 }, { label: 'zeros', kind: 3 }] }),
  [{ label: 'x', kind: 'v' }, { label: 'f', kind: 'f' }, { label: 'for', kind: 'k' }, { label: 'zeros', kind: 'F' }]);
assert.deepStrictEqual(completionItems([{ label: 'a' }]), [{ label: 'a', kind: 'F' }]);
assert.strictEqual(completionItems({}), undefined);
assert.strictEqual(textOf(['json']), 'json');
assert.strictEqual(textOf({ value: 'v' }), 'v');
assert.strictEqual(matlabString("C:\\it's.m"), "'C:\\it''s.m'");

console.log('parsing: all assertions passed');

// ---- hideHelperFrames: run() frames in errors and warning backtraces ----
{
  const warn = 'Warning: The name "a" matches multiple I/O channels.\n> In ltipack/LabeledIOModel/name2index (line 1044)\n'
    + 'In () (line 128)\nIn WELLE v6 TMD Design (line 60)\nIn run (line 100)\nWarning: next\n';
  assert.strictEqual(hideHelperFrames(warn), 'Warning: The name "a" matches multiple I/O channels.\n> In ltipack/LabeledIOModel/name2index (line 1044)\n'
    + 'In () (line 128)\nIn WELLE v6 TMD Design (line 60)\nWarning: next\n', 'warning trace: run frame without ">" removed, next warning kept');
  assert.strictEqual(hideHelperFrames('  In f (line 2)\n  In run (line 100)\n'), '  In f (line 2)\n');
  assert.strictEqual(hideHelperFrames('> In run (line 100)\n'), '');
  const err = "Error using f\nboom\nError in s (line 3)\n    f()\n    ^^^\nError in run (line 100)\n    evalin('caller', strcat(script, ';'));\n    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n";
  assert.strictEqual(hideHelperFrames(err), 'Error using f\nboom\nError in s (line 3)\n    f()\n    ^^^\n');
  assert.strictEqual(hideHelperFrames('Error in run (line 100)\nError in x (line 1)\n'), 'Error in x (line 1)\n', 'never eats the next frame');
  assert.strictEqual(hideHelperFrames('In running (line 3)\nIn myrun (line 4)\n'), 'In running (line 3)\nIn myrun (line 4)\n', 'other names kept');
}

// ---- classifyErrLines: a warning's whole backtrace is yellow, errors red ----
{
  const warnOf = (chunks: string[]) => {
    const st = { inWarning: false, lineOpen: false };
    return chunks.flatMap(c => classifyErrLines(c, st)).map(l => ((l.warn ? 'W ' : 'E ') + l.text.trimEnd()).trimEnd());
  };
  // The user's output (R2026b, a script run with run()): the frames after the first have no "> " and no indent.
  assert.deepStrictEqual(warnOf(['Warning: The name "a" matches multiple I/O channels.\n> In ltipack/LabeledIOModel/name2index (line 1044)\nIn () (line 128)\nIn WELLE v6 TMD Design (line 64)\n']),
    ['W Warning: The name "a" matches multiple I/O channels.', 'W > In ltipack/LabeledIOModel/name2index (line 1044)', 'W In () (line 128)', 'W In WELLE v6 TMD Design (line 64)']);
  assert.deepStrictEqual(warnOf(['Warning: x\n> In f (line 3)\n  In g (line 9)\nError using h\nboom\n']),
    ['W Warning: x', 'W > In f (line 3)', 'W   In g (line 9)', 'E Error using h', 'E boom'], 'indented frames; an error after it is red');
  assert.deepStrictEqual(warnOf(['Warning: x\n> In f (line 3)\nIn g (li', 'ne 9)\nIn h (line 1)\n']),
    ['W Warning: x', 'W > In f (line 3)', 'W In g (li', 'W ne 9)', 'W In h (line 1)'], 'a line cut between two chunks keeps its colour');
  assert.deepStrictEqual(warnOf(['Error using f\nIn the input (line 2)\n']), ['E Error using f', 'E In the input (line 2)'], '"In ..." after an error stays red');
  assert.deepStrictEqual(warnOf(['Warning: x\n> In f (line 3)\n', '\n', 'Error in s (line 1)\n']), ['W Warning: x', 'W > In f (line 3)', 'E', 'E Error in s (line 1)']);
}

// ---- maybePathArgument: when to ask MATLAB for file/folder completions ----
import { maybePathArgument } from '../src/language/matlabSyntax';
for (const yes of ["load('", "load('da", "addpath(p, \"src\\", 'cd ', 'cd ..\da', 'load data', '  genpath(\'C:\Us', "x = readtable('d"]) {
  assert.ok(maybePathArgument(yes), `path argument: ${yes}`);
}
for (const no of ['x = 3', 'disp(', "disp('a') ", "s = 'abc", '% load(\'', 'if x', "x = ['a", 'a == b', "load('a.mat') "]) {
  assert.ok(!maybePathArgument(no), `not a path argument: ${no}`);
}

// ---- historyRows: the Command History pop-up ----
import { historyRows } from '../src/commandWindow/webview/historyRows';
{
  const h = ['a = 1', 'plot(x)', 'plot(x)', 'b = 2', 'plot(x)', 'a = 3', '', 'a = 3'];
  assert.deepStrictEqual(historyRows(h, ''), [
    { text: 'a = 1', count: 1 }, { text: 'plot(x)', count: 2 }, { text: 'b = 2', count: 1 }, { text: 'plot(x)', count: 1 }, { text: 'a = 3', count: 1 },
    { text: 'a = 3', count: 1 }], 'only repeats right after each other are counted (an empty line between breaks it)');
  assert.deepStrictEqual(historyRows(h, 'a').map(r => r.text), ['a = 1', 'a = 3', 'a = 3'], 'filtered by prefix');
  assert.deepStrictEqual(historyRows(['x', 'y', 'x', 'x'], 'x'), [{ text: 'x', count: 1 }, { text: 'x', count: 2 }], 'a repeat hidden by the filter is not merged');
  assert.deepStrictEqual(historyRows(['a1', 'a2', 'a3'], 'a', 2).map(r => r.text), ['a2', 'a3'], 'the newest rows');
}

// ---- editor hover: which name, and the documentation link ----
import { hoverName } from '../src/language/matlabSyntax';
import { docUrlFromWhich } from '../src/language/helpText';
{
  const at = (line: string, word: string, k = 1) => hoverName(line, line.indexOf(word) + k)?.name;
  assert.strictEqual(at('y = zeros(3, n);', 'zeros'), 'zeros');
  assert.strictEqual(at('y = zeros(3, n);', 'n'), 'n');
  assert.strictEqual(at("disp('zeros here')", 'zeros'), undefined, 'not in a string');
  assert.strictEqual(at('s = "plot it"; plot(s)', 'plot('), 'plot', 'after a string');
  assert.strictEqual(at("a = b'; c = mean(a)", 'mean'), 'mean', "transpose is not a string");
  assert.strictEqual(at('x = 1; % zeros', 'zeros'), undefined, 'not in a comment');
  assert.strictEqual(at('v = s.mean + 1', 'mean'), undefined, 'not a field');
  assert.strictEqual(at('x1 = sum(y)', 'sum'), 'sum', 'after a name ending in a digit');
  assert.strictEqual(at('t = 1e5 + abs(t)', 'e5', 0), undefined, 'not inside a number');
  assert.strictEqual(at('t = 1e5 + abs(t)', 'abs'), 'abs');
  assert.strictEqual(at("fprintf('%d\\n', max(v))", 'max'), 'max', '% inside a string is not a comment');
  assert.strictEqual(hoverName('x = 1 + 2', 6), undefined, 'not on a name');

  const W = 'C:\\Program Files\\MATLAB\\R2026b\\toolbox';
  assert.strictEqual(docUrlFromWhich('zeros', `built-in (${W}\\matlab\\elmat\\zeros)`), 'https://www.mathworks.com/help/matlab/ref/zeros.html');
  assert.strictEqual(docUrlFromWhich('linspace', `${W}\\matlab\\elmat\\linspace.m`), 'https://www.mathworks.com/help/matlab/ref/linspace.html');
  assert.strictEqual(docUrlFromWhich('fitlm', '/usr/local/MATLAB/R2025a/toolbox/stats/stats/fitlm.m'), 'https://www.mathworks.com/help/stats/ref/fitlm.html');
  assert.strictEqual(docUrlFromWhich('plot', '/Applications/MATLAB_R2026b.app/toolbox/matlab/graphics/plot.m'), 'https://www.mathworks.com/help/matlab/ref/plot.html');
  assert.strictEqual(docUrlFromWhich('mean_of', 'C:\\Users\\me\\proj\\mean_of.m'), undefined, 'user function');
  assert.strictEqual(docUrlFromWhich('helper', `${W}\\matlab\\elmat\\private\\helper.m`), undefined, 'private');
  assert.strictEqual(docUrlFromWhich('x', 'x is a variable.'), undefined);
  assert.strictEqual(docUrlFromWhich('f', `${W}\\shared\\x\\f.m`), undefined, 'shared');
}
