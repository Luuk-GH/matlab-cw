// Unit checks for signature help, on real data recorded from MATLAB R2026b (test/fixtures/getCompletions-R2026b.json:
// raw results of matlabls.internal.getCompletions for a few inputs). Run: npm run test:unit
import * as assert from 'assert';
import { parseSignatures } from '../src/language/signatures';
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

console.log('signatures: all assertions passed');
