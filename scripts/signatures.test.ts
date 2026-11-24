// Unit checks for signature help, on real data recorded from MATLAB R2026b (test/fixtures/getCompletions-R2026b.json:
// raw results of matlabls.internal.getCompletions for a few inputs). Run: npm run test:unit
import * as assert from 'assert';
import { parsePathChoices, parseSignatures } from '../src/language/signatures';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recorded = require('../test/fixtures/getCompletions-R2026b.json') as Record<string, unknown[]>;
const parse = (code: string) => parseSignatures(recorded[code][0]);

// plot( : like the MATLAB desktop, the suggested form first, the untyped leading `ax` hidden, the cursor on Y.
let r = parse('plot(')!;
assert.strictEqual(r.forms[0].label, 'plot(Y,LineSpec,options)');
const y = r.forms[0].params[r.forms[0].active];
assert.deepStrictEqual([y.name, y.purpose, y.valueSummary], ['Y', 'y-coordinates', 'scalar | vector | matrix']);
assert.ok(r.forms.length >= 5, 'several forms');
assert.strictEqual(new Set(r.forms.map(f => f.label)).size, r.forms.length, 'no duplicate forms');

// linspace(0,  : one form, cursor on the second argument.
r = parse('linspace(0, ')!;
assert.strictEqual(r.forms.length, 1);
assert.strictEqual(r.forms[0].label, 'linspace(x1,x2,n)');
assert.strictEqual(r.forms[0].params[r.forms[0].active].name, 'x2');
assert.strictEqual(r.forms[0].params[r.forms[0].active].purpose, 'Point interval');

// mean(a,  : the cursor on the second argument of the suggested form.
r = parse('y = mean(a, ')!;
assert.strictEqual(r.forms[0].params[r.forms[0].active].name, 'dim');

// A user function without signature data: nothing (the Command Window falls back to its help text).
assert.strictEqual(parse('mean_of('), undefined);
assert.strictEqual(parseSignatures(undefined), undefined);
assert.strictEqual(parseSignatures({ widgetType: 'none' }), undefined);

// A single struct instead of a cell (one form, one argument).
r = parseSignatures({ signatures: { functionName: 'f', inputArguments: { name: 'x', kind: 'required', status: 'presenting' } } })!;
assert.deepStrictEqual(r.forms.map(f => [f.label, f.active]), [['f(x)', 0]]);

// ---- file/folder completion (test/fixtures/pathCompletions-R2026b.json, recorded in this repository's folder) ----
{
  const paths = require('../test/fixtures/pathCompletions-R2026b.json') as Record<string, unknown[]>;
  const pc = (code: string) => parsePathChoices(paths[code][0]);
  const load = pc("load('")!;
  assert.strictEqual(load.from, 5, "load(': replaces from the quote");
  assert.ok(load.choices[0].folder && load.choices[0].label === 'dist\\' && load.choices[0].insert === "'dist\\", 'folders first, no closing quote');
  const file = load.choices.find(c => c.label === 'CHANGELOG.md');
  assert.ok(file && !file.folder && file.insert === "'CHANGELOG.md'", 'files closed with a quote');
  assert.deepStrictEqual(pc('cd sc'), { from: 3, choices: [{ label: 'scripts\\', insert: 'scripts\\', folder: true }] }, 'command syntax');
  assert.deepStrictEqual(pc("load('docs\\")!.choices.map(c => c.label), ['screenshots\\', 'video\\'], 'into a folder');
  assert.ok(pc('addpath(\'')!.choices.every(c => c.folder), 'addpath: folders only');
  assert.ok(pc("imread('d")!.choices.some(c => c.label === 'demoicon.gif'), 'files on the path (pathItem)');
  assert.strictEqual(pc('zeros('), undefined, 'not a file argument');
  assert.strictEqual(pc("disp('"), undefined, 'not a file argument');
}

console.log('signatures: all assertions passed');
