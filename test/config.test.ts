import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateConfig,
  loadConfigFile,
  defaultConfig,
  DEFAULT_TEST_GLOBS,
} from '../src/config.js';
import { FIXTURES } from './util.js';

test('null raw config yields defaults', () => {
  const { config, errors } = validateConfig(null);
  assert.deepEqual(errors, []);
  assert.ok(config);
  assert.deepEqual(config, defaultConfig());
  assert.ok(DEFAULT_TEST_GLOBS.includes('**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'));
});

test('a full valid config is accepted', () => {
  const { config, errors } = validateConfig({
    testGlobs: ['**/*.probe.js'],
    ignore: ['vendor'],
    ignoreWeakOnly: true,
  });
  assert.deepEqual(errors, []);
  assert.ok(config);
  assert.deepEqual(config.testGlobs, ['**/*.probe.js']);
  assert.deepEqual(config.ignore, ['vendor']);
  assert.equal(config.ignoreWeakOnly, true);
});

test('unknown options are reported', () => {
  const { errors } = validateConfig({ typoHere: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown option "typoHere"/);
});

test('non-mapping config is reported', () => {
  const { errors } = validateConfig(['a', 'b']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a YAML mapping/);
});

test('errors accumulate across options', () => {
  const { errors, config } = validateConfig({
    testGlobs: 'not-an-array',
    unknownOption: true,
    ignoreWeakOnly: 'yes',
  });
  assert.equal(config, null);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes('testGlobs must be a non-empty array')));
  assert.ok(errors.some((e) => e.includes('unknown option "unknownOption"')));
  assert.ok(errors.some((e) => e.includes('ignoreWeakOnly must be a boolean')));
});

test('empty testGlobs array is rejected', () => {
  const { errors } = validateConfig({ testGlobs: [] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /testGlobs must be a non-empty array/);
});

test('ignore with non-string entries is rejected', () => {
  const { errors } = validateConfig({ ignore: ['ok', 42] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ignore must be an array of strings/);
});

test('loadConfigFile reads a valid yaml file', () => {
  const { config, errors } = loadConfigFile(`${FIXTURES}config/probes.yaml`);
  assert.deepEqual(errors, []);
  assert.ok(config);
  assert.deepEqual(config.testGlobs, ['**/*.probe.js']);
});

test('loadConfigFile accumulates validation errors from a bad file', () => {
  const { config, errors } = loadConfigFile(`${FIXTURES}config/bad.yaml`);
  assert.equal(config, null);
  assert.equal(errors.length, 3);
});

test('loadConfigFile reports malformed yaml', () => {
  const { config, errors } = loadConfigFile(`${FIXTURES}config/malformed.yaml`);
  assert.equal(config, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid YAML/);
});

test('loadConfigFile reports a missing file', () => {
  const { errors } = loadConfigFile(`${FIXTURES}config/does-not-exist.yaml`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot read config file/);
});

test('config file used by this suite is valid utf8 text', () => {
  const text = readFileSync(`${FIXTURES}config/bad.yaml`, 'utf8');
  assert.ok(text.includes('unknownOption'));
});
