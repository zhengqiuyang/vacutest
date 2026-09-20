import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runCli, makeInsertionPatch, makeReplacePatch, FIXTURES } from './util.js';

const GATE_REPO = `${FIXTURES}gate${'/'}`;

function gatePatches() {
  const probe = readFileSync(`${GATE_REPO}repo/probe.test.js`, 'utf8').replace(/\r\n?/g, '\n');
  const lines = probe.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  // Base without the "vacuous added by patch" test (lines 5-8, 0-based 5..8).
  const vacuousBlock = lines.slice(5, 9);
  const baseVacuous = lines.filter((_, i) => i < 5 || i >= 9);
  const patchVacuous = makeInsertionPatch('probe.test.js', baseVacuous, 5, vacuousBlock);
  // Base without the "good added by other patch" test (lines 9-11, 0-based 9..11).
  const goodBlock = lines.slice(9, 12);
  const baseGood = lines.filter((_, i) => i < 9);
  const patchGood = makeInsertionPatch('probe.test.js', baseGood, 9, goodBlock);
  return { patchVacuous, patchGood, lines };
}

test('scan on the vacuous fixture dir exits 1 and lists every rule', () => {
  const res = runCli(['scan', `${FIXTURES}vacuous`]);
  assert.equal(res.status, 1);
  for (const rule of ['NO_ASSERTION', 'EMPTY_TEST', 'TAUTOLOGY_LITERAL', 'WEAK_ONLY', 'SILENT_CATCH', 'SNAPSHOT_NOASSERT']) {
    assert.ok(res.stdout.includes(rule), `expected ${rule} in output`);
  }
  assert.ok(res.stdout.includes('sample.test.js:1'));
});

test('scan on the clean near-miss fixture dir exits 0', () => {
  const res = runCli(['scan', `${FIXTURES}clean`]);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.ok(res.stdout.includes('No vacuous tests found'));
});

test('scan --format json produces machine-readable output', () => {
  const res = runCli(['scan', `${FIXTURES}vacuous`, '--format', 'json']);
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.summary.findings, 6);
  assert.equal(parsed.findings.length, 6);
  assert.equal(parsed.summary.byRule.EMPTY_TEST, 1);
  for (const f of parsed.findings) {
    assert.ok(typeof f.line === 'number' && f.line >= 1);
    assert.ok(typeof f.evidence === 'string' && f.evidence.length <= 100);
    assert.ok(typeof f.why === 'string' && f.why.length > 0);
  }
});

test('scan on a single file path works', () => {
  const res = runCli(['scan', `${FIXTURES}vacuous/sample.test.js`, '--format', 'json']);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).summary.findings, 6);
});

test('scan on a nonexistent path exits 2', () => {
  const res = runCli(['scan', 'C:/definitely/not/here']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /does not exist/);
});

test('unknown command exits 2', () => {
  const res = runCli(['frobnicate']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command/);
});

test('unknown option exits 2', () => {
  const res = runCli(['scan', '--bogus', `${FIXTURES}clean`]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--bogus/);
});

test('--help and --version exit 0', () => {
  assert.equal(runCli(['--help']).status, 0);
  assert.equal(runCli(['--version']).status, 0);
  assert.ok(runCli(['--version']).stdout.trim().startsWith('0.1.0'));
});

test('gate without --diff exits 2', () => {
  const res = runCli(['gate', `${GATE_REPO}repo`]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--diff/);
});

test('gate with a patch adding a vacuous test exits 1 pointing at the added line', () => {
  const { patchVacuous } = gatePatches();
  const dir = mkdtempSync(join(tmpdir(), 'vacutest-gate-'));
  try {
    const patchPath = join(dir, 'add-vacuous.patch');
    writeFileSync(patchPath, patchVacuous);
    const res = runCli(['gate', '--diff', patchPath, `${GATE_REPO}repo`, '--format', 'json']);
    assert.equal(res.status, 1, `stdout: ${res.stdout}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.findings.length, 1);
    const f = parsed.findings[0];
    assert.equal(f.rule, 'WEAK_ONLY');
    assert.equal(f.test, 'vacuous added by patch');
    assert.equal(f.line, 6); // the added test('...') line in the post-patch file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate with a patch adding a good test exits 0 despite pre-existing debt', () => {
  const { patchGood } = gatePatches();
  const dir = mkdtempSync(join(tmpdir(), 'vacutest-gate-'));
  try {
    const patchPath = join(dir, 'add-good.patch');
    writeFileSync(patchPath, patchGood);
    const res = runCli(['gate', '--diff', patchPath, `${GATE_REPO}repo`]);
    assert.equal(res.status, 0, `stdout: ${res.stdout}`);
    assert.ok(res.stdout.includes('No vacuous tests introduced by this diff'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate catches a tautology introduced by modifying an existing assertion', () => {
  const changed = readFileSync(`${GATE_REPO}repo/changed.test.js`, 'utf8').replace(/\r\n?/g, '\n');
  const lines = changed.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const patch = makeReplacePatch(
    'changed.test.js',
    lines,
    2,
    '  expect(user).toBe(user.clone);',
    '  expect(user).toBe(user);',
  );
  const dir = mkdtempSync(join(tmpdir(), 'vacutest-gate-'));
  try {
    const patchPath = join(dir, 'modify.patch');
    writeFileSync(patchPath, patch);
    const res = runCli(['gate', '--diff', patchPath, `${GATE_REPO}repo`, '--format', 'json']);
    assert.equal(res.status, 1, `stdout: ${res.stdout}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].rule, 'TAUTOLOGY_LITERAL');
    assert.equal(parsed.findings[0].evidenceLine, 3); // the modified (added) line
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate with a missing diff file exits 2', () => {
  const res = runCli(['gate', '--diff', 'C:/no/such.patch', `${GATE_REPO}repo`]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot read diff/);
});

test('--config applies custom testGlobs', () => {
  const withCfg = runCli(['scan', `${FIXTURES}config`, '--config', `${FIXTURES}config/probes.yaml`, '--format', 'json']);
  assert.equal(withCfg.status, 1, `stdout: ${withCfg.stdout}`);
  const parsed = JSON.parse(withCfg.stdout);
  assert.equal(parsed.summary.filesScanned, 1);
  assert.equal(parsed.findings[0].rule, 'WEAK_ONLY');
  assert.ok(parsed.findings[0].file.replace(/\\/g, '/').endsWith('a.probe.js'));

  const withoutCfg = runCli(['scan', `${FIXTURES}config`]);
  assert.equal(withoutCfg.status, 0);
});

test('--config with accumulated validation errors exits 2 listing all of them', () => {
  const res = runCli(['scan', `${FIXTURES}clean`, '--config', `${FIXTURES}config/bad.yaml`]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /testGlobs must be a non-empty array/);
  assert.match(res.stderr, /unknown option "unknownOption"/);
  assert.match(res.stderr, /ignoreWeakOnly must be a boolean/);
});

test('--config with malformed yaml exits 2', () => {
  const res = runCli(['scan', `${FIXTURES}clean`, '--config', `${FIXTURES}config/malformed.yaml`]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid YAML/);
});

test('CRLF fixture files are detected with correct line numbers', () => {
  const src = [
    'const helper = 1;',
    "test('crlf weak', () => {",
    '  const r = helper;',
    '  expect(r).toBeDefined();',
    '});',
  ].join('\r\n');
  const dir = mkdtempSync(join(tmpdir(), 'vacutest-crlf-'));
  try {
    mkdirSync(join(dir, 'suite'));
    writeFileSync(join(dir, 'suite', 'crlf.test.js'), src);
    const res = runCli(['scan', dir, '--format', 'json']);
    assert.equal(res.status, 1, `stdout: ${res.stdout}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.findings[0].line, 2);
    assert.equal(parsed.findings[0].rule, 'WEAK_ONLY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
