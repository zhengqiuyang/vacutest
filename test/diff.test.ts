import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/diff.js';

function addedOf(patch: string, file: string): number[] {
  const map = parseUnifiedDiff(patch);
  return [...(map.get(file.toLowerCase()) ?? [])].sort((a, b) => a - b);
}

test('a simple insertion maps added line numbers in the new file', () => {
  const patch = [
    'diff --git a/probe.test.js b/probe.test.js',
    '--- a/probe.test.js',
    '+++ b/probe.test.js',
    '@@ -1,3 +1,6 @@',
    ' const a = 1;',
    '+test("added", () => {',
    '+  expect(1).toBe(1);',
    '+});',
    ' const b = 2;',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'probe.test.js'), [2, 3, 4]);
});

test('context lines are not counted as added', () => {
  const patch = [
    '+++ b/x.js',
    '@@ -5,3 +5,3 @@',
    ' keep1',
    '-old',
    '+new',
    ' keep2',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'x.js'), [6]);
});

test('multiple hunks in one file accumulate', () => {
  const patch = [
    '+++ b/x.js',
    '@@ -1,2 +1,3 @@',
    ' ctx',
    '+add1',
    ' ctx',
    '@@ -10,2 +11,3 @@',
    ' ctx',
    '+add2',
    ' ctx',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'x.js'), [2, 12]);
});

test('multiple files map independently', () => {
  const patch = [
    'diff --git a/a.test.js b/a.test.js',
    '--- a/a.test.js',
    '+++ b/a.test.js',
    '@@ -1,1 +1,2 @@',
    ' ctx',
    '+one',
    'diff --git a/b.test.js b/b.test.js',
    '--- a/b.test.js',
    '+++ b/b.test.js',
    '@@ -1,1 +1,2 @@',
    ' ctx',
    '+two',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'a.test.js'), [2]);
  assert.deepEqual(addedOf(patch, 'b.test.js'), [2]);
});

test('deleted files (/dev/null) produce no added lines', () => {
  const patch = [
    'diff --git a/gone.test.js b/gone.test.js',
    'deleted file mode 100644',
    '--- a/gone.test.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-test("gone", () => {});',
    '-test("gone2", () => {});',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'gone.test.js'), []);
});

test('new files start added lines at line 1', () => {
  const patch = [
    'diff --git a/new.test.js b/new.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.test.js',
    '@@ -0,0 +1,3 @@',
    '+test("brand new", () => {',
    '+  const v = load();',
    '+  expect(v).toBeDefined();',
    '+});',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'new.test.js'), [1, 2, 3, 4]);
});

test('a removal-only hunk produces no added lines', () => {
  const patch = [
    '+++ b/x.js',
    '@@ -1,3 +1,2 @@',
    ' ctx',
    '-gone',
    ' ctx',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'x.js'), []);
});

test('CRLF patch text is handled', () => {
  const patch = [
    '+++ b/x.js',
    '@@ -1,2 +1,3 @@',
    ' ctx',
    '+added',
    ' ctx',
  ].join('\r\n');
  assert.deepEqual(addedOf(patch, 'x.js'), [2]);
});

test('deletion lines that begin with --- inside a hunk do not confuse headers', () => {
  // A deleted source line whose content starts with "-- " renders as "--- ..." in a hunk.
  const patch = [
    '+++ b/x.js',
    '@@ -1,3 +1,2 @@',
    ' ctx',
    '--- a line that was deleted',
    ' ctx',
  ].join('\n');
  assert.deepEqual(addedOf(patch, 'x.js'), []);
});

test('paths without the b/ prefix still resolve', () => {
  const patch = ['+++ x.js', '@@ -1,1 +1,2 @@', ' ctx', '+add', ' ctx'].join('\n');
  assert.deepEqual(addedOf(patch, 'x.js'), [2]);
});
