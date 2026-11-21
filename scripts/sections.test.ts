// Unit checks for MATLAB code sections (Run Section). Run: npm run test:unit
import * as assert from 'assert';
import { isSectionHeader, onlyComments, sectionAt } from '../src/language/sections';

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

assert.ok(onlyComments('%% Title\n% note\n\n   '));
assert.ok(!onlyComments('%% Title\nx = 1;'));

console.log('sections: all assertions passed');
