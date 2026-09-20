import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, findTestFiles } from '../src/walk.js';
import { FIXTURES } from './util.js';
import { defaultConfig } from '../src/config.js';

test('glob: **/*.test.js matches at any depth including root', () => {
  const re = globToRegex('**/*.test.js');
  assert.ok(re.test('a.test.js'));
  assert.ok(re.test('src/a.test.js'));
  assert.ok(re.test('a/b/c/a.test.js'));
  assert.ok(!re.test('a.spec.js'));
  assert.ok(!re.test('sub/a.test.jsx'));
});

test('glob: brace alternation works', () => {
  const re = globToRegex('**/*.test.{js,ts}');
  assert.ok(re.test('x.test.js'));
  assert.ok(re.test('x.test.ts'));
  assert.ok(!re.test('x.test.mjs'));
});

test('glob: **/test/** matches files nested under a test dir', () => {
  const re = globToRegex('**/test/**/*.{js,ts}');
  assert.ok(re.test('test/foo.js'));
  assert.ok(re.test('test/sub/foo.ts'));
  assert.ok(!re.test('src/foo.js'));
});

test('glob: ? matches a single path char', () => {
  const re = globToRegex('a?c.js');
  assert.ok(re.test('abc.js'));
  assert.ok(!re.test('ac.js'));
  assert.ok(!re.test('a/c.js'));
});

test('findTestFiles discovers fixture test files and skips helpers', () => {
  const cfg = defaultConfig();
  const files = findTestFiles(`${FIXTURES}clean`, { testGlobs: cfg.testGlobs, ignore: cfg.ignore })
    .map((f) => f.replace(/\\/g, '/').split('/').pop());
  assert.deepEqual(files, ['near-misses.test.js']);
});

test('findTestFiles prunes default ignore dirs', () => {
  const re = globToRegex('**/*.probe.js');
  const files = findTestFiles(`${FIXTURES}config`, { testGlobs: ['**/*.probe.js'], ignore: [] });
  assert.equal(files.length, 1);
  assert.ok(re.test(files[0].replace(/\\/g, '/').split('fixtures/')[1] ?? ''));
});

test('config ignore entries exclude directories by name', () => {
  const files = findTestFiles(`${FIXTURES}gate`, {
    testGlobs: ['**/*.test.js', '**/repo/**'],
    ignore: ['repo'],
  });
  assert.equal(files.length, 0);
});
