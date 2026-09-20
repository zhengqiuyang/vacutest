#!/usr/bin/env node
/**
 * vacutest demo: a fixture suite with 6 vacuous + 6 legit tests,
 * a full scan, then diff-gating on two patches (one adds a vacuous test,
 * one adds a good test). Everything is generated under demo/tmp (gitignored).
 */
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cli = join(root, 'dist', 'src', 'cli.js');
const tmp = join(root, 'demo', 'tmp');

// ---------------------------------------------------------------------------
// Fixture suite: 6 vacuous tests (one per rule) + 6 legit tests.
// ---------------------------------------------------------------------------

const suite = `import test from 'node:test';

// ---- vacuous (each one trips a different rule) ----

test('health endpoint responds', async () => {
  const res = await fetchHealth();
  expect(res).toBeDefined();
});

test('empty placeholder', () => {
  // TODO: write this test
});

test('config roundtrip is stable', () => {
  const cfg = { retries: 2 };
  expect(cfg).toBe(cfg);
});

test('worker tolerates bad jobs', async () => {
  try {
    await worker.process(badJob);
    expect(worker.count()).toBe(1);
  } catch {}
});

test('rendered markup snapshot', () => {
  expect(mockPage).toMatchSnapshot();
});

test('migration completes', () => {
  const report = migrate('./legacy.db');
  console.log(report.summary);
});

// ---- legit (near-misses; must stay clean) ----

test('health endpoint returns 200 with ok body', async () => {
  const res = await fetchHealth();
  expect(res.status).toBe(200);
  expect(res.body).toContain('ok');
});

test('adds numbers', () => {
  expect(add(1, 2)).toBe(3);
});

test('boom rejects with message', async () => {
  await expect(detonate()).rejects.toThrow('boom');
});

test('swallowing is asserted explicitly', () => {
  let swallowed = null;
  try {
    detonate();
  } catch (e) {
    swallowed = e.message;
  }
  expect(swallowed).toBe('boom');
});

test('live render snapshot plus content check', () => {
  const html = render();
  expect(html).toMatchSnapshot();
  expect(html).toContain('Total');
});

test('deep equality of sorted rows', () => {
  assert.deepEqual([2, 1].sort(), [1, 2]);
});

function add(a, b) { return a + b; }
function fetchHealth() { return Promise.resolve({ status: 200, body: 'ok' }); }
function detonate() { return Promise.reject(new Error('boom')); }
function render() { return '<table>Total: 3</table>'; }
function migrate(db) { return { summary: 'done' }; }
const mockPage = { title: 'Demo', rows: [] };
const badJob = { id: 0 };
const worker = { process: async () => {}, count: () => 1 };
`;

// The same file minus the vacuous test added by patch A / the good test added
// by patch B (diffs describe the working tree; we generate both from `suite`).
const lines = suite.split('\n');

function blockRange(name) {
  const start = lines.findIndex((l) => l.includes(`test('${name}'`));
  if (start === -1) throw new Error(`cannot locate test ${name} in suite`);
  let end = start;
  while (end < lines.length && lines[end] !== '});') end++;
  return [start, end + 1]; // inclusive
}

function insertionPatch(file, base, at, added, ctx = 3) {
  const start = Math.max(0, at - ctx);
  const end = Math.min(base.length, at + ctx);
  const out = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start + 1},${end - start} +${start + 1},${end - start + added.length} @@`,
  ];
  for (let i = start; i < at; i++) out.push(' ' + base[i]);
  for (const l of added) out.push('+' + l);
  for (let i = at; i < end; i++) out.push(' ' + base[i]);
  return out.join('\n') + '\n';
}

// Patch A: an agent adds the "health endpoint responds" vacuous test.
const [va, vb] = blockRange('health endpoint responds');
const vacuousBlock = lines.slice(va, vb);
const baseA = lines.filter((_, i) => i < va || i >= vb);
const patchVacuous = insertionPatch('all.test.js', baseA, va, vacuousBlock);

// Patch B: an agent adds a good test at the end (before the helpers).
const helperIdx = lines.findIndex((l) => l.startsWith('function add('));
const goodBlock = [
  "test('formats totals for reports', () => {",
  "  expect(formatTotal(3)).toBe('Total: 3');",
  '});',
  '',
];
const baseB = lines.slice(); // good test appended before helpers
const patchGood = insertionPatch('all.test.js', baseB, helperIdx, goodBlock);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, 'suite'), { recursive: true });
writeFileSync(join(tmp, 'suite', 'all.test.js'), suite);
writeFileSync(join(tmp, 'add-vacuous.patch'), patchVacuous);
writeFileSync(join(tmp, 'add-good.patch'), patchGood);

function run(args) {
  const res = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
  return { status: res.status ?? -1, out: (res.stdout || '') + (res.stderr || '') };
}

const hr = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

hr('1) scan — the 2-second pre-gate over the whole fixture suite');
const scan = run(['scan', join(tmp, 'suite')]);
console.log(scan.out);
console.log(`[exit code: ${scan.status}]`);

hr('2) gate — an agent PR that ADDS a vacuous test (add-vacuous.patch)');
console.log(patchVacuous.split('\n').slice(0, 8).join('\n') + '\n...');
const gateBad = run(['gate', '--diff', join(tmp, 'add-vacuous.patch'), join(tmp, 'suite')]);
console.log(gateBad.out);
console.log(`[exit code: ${gateBad.status}]  <- blocks the PR`);

hr('3) gate — an agent PR that adds a GOOD test (add-good.patch)');
const gateGood = run(['gate', '--diff', join(tmp, 'add-good.patch'), join(tmp, 'suite')]);
console.log(gateGood.out);
console.log(`[exit code: ${gateGood.status}]  <- pre-existing debt is ignored; only diff-introduced findings block`);

hr('summary');
console.log(`scan found 6 vacuous tests; gate blocked the diff that introduced one (exit 1)`);
console.log(`and passed the diff that introduced none (exit 0).`);
