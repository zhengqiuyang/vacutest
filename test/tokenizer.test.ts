import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInSource, findTestCalls, tokenize } from '../src/detect.js';

function blocksOf(src: string) {
  const norm = src.replace(/\r\n?/g, '\n');
  return findTestCalls(norm, tokenize(norm));
}

test('finds a plain test() with function callback', () => {
  const calls = blocksOf(`test('a', function () { expect(1).toBe(1); });`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'a');
});

test('finds it() with arrow callback and extracts name', () => {
  const calls = blocksOf(`it('b', () => { expect(1).toBe(1); });`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'b');
});

test('template literal test names are supported', () => {
  const calls = blocksOf('test(`tpl ${1}`, () => { expect(1).toBe(1); });');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].name !== null && calls[0].name.includes('tpl'));
});

test('expression arrow body is recognized and analyzed', () => {
  const res = detectInSource(`test('expr', () => expect(2).toBe(1 + 1));`, 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('unbalanced braces inside strings do not break block bounds', () => {
  const src = `test('braces', () => {
  expect('}{'.length).toBe(2);
});
test('still found', () => {
  expect('}'.charCodeAt(0)).toBe(125);
});`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 2);
  assert.equal(res.findings.length, 0);
});

test('template literals with interpolation keep block bounds stable', () => {
  const src = 'const msg = `run ${`inner ${1}`} done {`;\n' +
    "test('tpl', () => { expect(msg).toContain('run'); expect(2).toBe(1 + 1); });";
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('comments containing test( calls are ignored', () => {
  const src = `// test('fake', () => { expect(1).toBe(1); });
/* it('also fake', () => {}) */
test('real', () => { assert.equal(1, 1); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
});

test('regex literals with braces and quotes do not break bounds', () => {
  const src = `test('re', () => {
  expect('a{b}"c'.replace(/[{}"]/g, '')).toBe('abc');
});
test('after regex', () => { assert.equal(1 + 1, 2); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 2);
  assert.equal(res.findings.length, 0);
});

test('member calls like foo.test( are not test blocks', () => {
  const src = `foo.test('x'); mytest('y'); const it = 1; expect(it).toBe(1);`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 0);
});

test('test.skip / test.todo / test.fixme blocks are excluded from findings', () => {
  const src = `test.skip('a', () => {});
it.skip('b', () => { expect(true).toBe(true); });
test.fixme('c', () => {});
test('d', () => { expect(2).toBe(1 + 1); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 4);
  assert.equal(res.findings.length, 0);
});

test('lifecycle hooks like test.after(fn) are not test blocks at all', () => {
  const src = `const scratch = mkdtempSync('/tmp/x');
test.after(() => rmSync(scratch, { recursive: true, force: true }));
it.beforeEach(() => resetDb());
test('real', () => { expect(rmSync.name.length).toBeGreaterThan(0); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('it.each([...])(name, fn) is found and analyzed', () => {
  const src = `it.each([1, 2])('doubles %d', (n) => {
  expect(n * 2).toBeGreaterThan(0);
});`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('it.each`template`(name, fn) is found', () => {
  const src = 'it.each`\n a | b\n 1 | 2\n`("adds ${a}+${b}", ({ a, b }) => {\n  assert.equal(Number(a) + Number(b), 3);\n});';
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('callback followed by timeout argument is still found', () => {
  const src = `test('with timeout', () => { expect(2).toBe(1 + 1); }, 1000);`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
});

test('options object before callback is handled', () => {
  const src = `test('opts', { skip: false }, () => { expect(2).toBe(1 + 1); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 1);
});

test('async function and async arrow callbacks', () => {
  const src = `test('afn', async function () { assert.ok(await Promise.resolve(true)); });
test('aarrow', async (t) => { t.equal(await Promise.resolve(2), 2); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 2);
  assert.equal(res.findings.length, 0);
});

test('tests nested inside describe blocks are found', () => {
  const src = `describe('outer', () => {
  describe('inner', () => {
    it('deep', () => { expect(2).toBe(1 + 1); });
  });
  it('mid', () => { assert.equal(1 + 1, 2); });
});`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 2);
  assert.equal(res.findings.length, 0);
});

test('CRLF sources produce identical findings and line numbers', () => {
  const lf = "test('a', () => {});\ntest('b', () => {\n  expect(true).toBe(true);\n});";
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = detectInSource(lf, 'x.test.js');
  const b = detectInSource(crlf, 'x.test.js');
  assert.deepEqual(b.findings.map((f) => [f.line, f.rule]), a.findings.map((f) => [f.line, f.rule]));
  assert.deepEqual(a.findings.map((f) => [f.line, f.rule]), [[1, 'EMPTY_TEST'], [2, 'TAUTOLOGY_LITERAL']]);
});

test('BOM-prefixed sources are handled', () => {
  const res = detectInSource('\uFEFF' + "test('a', () => { expect(2).toBe(1 + 1); });", 'x.test.js');
  assert.equal(res.testBlocks, 1);
  assert.equal(res.findings.length, 0);
});

test('line numbers are 1-based and point at the declaration', () => {
  const src = `// leading comment

const helper = 1;
test('target', () => {
  expect(helper).toBe(helper);
});`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].line, 4);
  assert.equal(res.findings[0].evidenceLine, 5);
});
