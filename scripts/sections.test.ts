// Unit checks for MATLAB code sections (Run Section). Run: npm run test:unit
import * as assert from 'assert';
import { isSectionHeader, nextSectionStart, onlyComments, previousSectionStart, sectionAt } from '../src/language/sections';

assert.ok(isSectionHeader('%% Load data'));
assert.ok(isSectionHeader('  %%'));
assert.ok(isSectionHeader('%%'));
assert.ok(!isSectionHeader('%%{'), 'block comment start');
assert.ok(!isSectionHeader('%%% not a header'));
assert.ok(!isSectionHeader('x = 1; %% trailing'));
assert.ok(!isSectionHeader('% one percent'));

const file = [
  'a = 1;',            // 0
  '%% Load',           // 1
  'b = 2;',            // 2
  '',                  // 3
  '%% Plot it',        // 4
  'plot(b)',           // 5
  '%%',                // 6
  'c = 3;',            // 7
];
assert.deepStrictEqual(sectionAt(file, 0), { start: 0, end: 0, title: '' }, 'code above the first header');
assert.deepStrictEqual(sectionAt(file, 1), { start: 1, end: 3, title: 'Load' }, 'cursor on a header');
assert.deepStrictEqual(sectionAt(file, 3), { start: 1, end: 3, title: 'Load' });
assert.deepStrictEqual(sectionAt(file, 5), { start: 4, end: 5, title: 'Plot it' });
assert.deepStrictEqual(sectionAt(file, 7), { start: 6, end: 7, title: '' }, 'untitled last section');
assert.deepStrictEqual(sectionAt(['x = 1;', 'y = 2;'], 1), { start: 0, end: 1, title: '' }, 'no headers: whole file');
assert.deepStrictEqual(sectionAt(file, 99), { start: 6, end: 7, title: '' }, 'line past the end is clamped');

assert.strictEqual(nextSectionStart(file, 0), 1);
assert.strictEqual(nextSectionStart(file, 2), 4, 'from inside a section');
assert.strictEqual(nextSectionStart(file, 4), 6, 'from a header');
assert.strictEqual(nextSectionStart(file, 7), undefined, 'last section');
assert.strictEqual(previousSectionStart(file, 7), 4);
assert.strictEqual(previousSectionStart(file, 5), 1, 'from inside a section');
assert.strictEqual(previousSectionStart(file, 1), 0, 'to the code above the first header');
assert.strictEqual(previousSectionStart(file, 0), undefined, 'first section');
assert.strictEqual(nextSectionStart(['x = 1;'], 0), undefined, 'no headers');

assert.ok(onlyComments('%% Title\n% note\n\n   '));
assert.ok(!onlyComments('%% Title\nx = 1;'));

console.log('sections: all assertions passed');
