// Unit checks for the pure MATLAB text helpers: input-line syntax, MATLAB hyperlinks, help text, feval results,
// completion items and the Workspace JSON. No VS Code, no MATLAB. Run: npm run test:unit
import * as assert from 'assert';
import { completionItems, fevalOutputs, inputPromptText } from '../src/backend/lsBackend';

assert.strictEqual(inputPromptText(['Enter a number: ']), 'Enter a number: ');
assert.strictEqual(inputPromptText('Name: '), 'Name: ');
assert.strictEqual(inputPromptText({ promptString: 'x? ' }), 'x? ');
assert.strictEqual(inputPromptText(undefined), '');
import { linkTarget, parseAnchors } from '../src/commandWindow/webview/anchors';
import { fileFromWhich, functionDeclaration, parseHelp } from '../src/language/helpText';
import { callContext, completionPrefix } from '../src/language/matlabSyntax';
import { isErrorText, matlabString, textOf } from '../src/sessionText';

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
assert.ok(isErrorText('agent boom\n'));
assert.ok(!isErrorText('Warning: careful\n> In f (line 3)\n'));
assert.ok(isErrorText('Warning: x\nError using f\n'));
assert.strictEqual(matlabString("C:\\it's.m"), "'C:\\it''s.m'");

console.log('parsing: all assertions passed');
