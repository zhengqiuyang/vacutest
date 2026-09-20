/**
 * vacutest.yaml loading + validation with accumulated errors.
 * Runtime deps: `yaml` (the only runtime dependency of vacutest).
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface VacutestConfig {
  testGlobs: string[];
  ignore: string[];
  ignoreWeakOnly: boolean;
}

export const DEFAULT_TEST_GLOBS: string[] = [
  '**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
  '**/*.spec.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
  '**/test.{js,mjs,cjs,ts}',
  '**/test/**/*.{js,mjs,cjs,ts}',
  '**/tests/**/*.{js,mjs,cjs,ts}',
  '**/__tests__/**/*.{js,mjs,cjs,ts}',
];

export const DEFAULT_IGNORE: string[] = ['node_modules', '.git', 'dist', 'build', 'coverage'];

const KNOWN_KEYS = new Set(['testGlobs', 'ignore', 'ignoreWeakOnly']);

export function defaultConfig(): VacutestConfig {
  return {
    testGlobs: [...DEFAULT_TEST_GLOBS],
    ignore: [...DEFAULT_IGNORE],
    ignoreWeakOnly: false,
  };
}

export interface ConfigLoad {
  config: VacutestConfig | null;
  errors: string[];
}

export function validateConfig(raw: unknown, sourceLabel = 'config'): ConfigLoad {
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { config: defaultConfig(), errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: [`${sourceLabel}: must be a YAML mapping, got ${Array.isArray(raw) ? 'array' : typeof raw}`] };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`${sourceLabel}: unknown option "${key}" (expected one of: testGlobs, ignore, ignoreWeakOnly)`);
    }
  }

  let testGlobs: string[] | null = null;
  if ('testGlobs' in obj) {
    const v = obj.testGlobs;
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.length > 0)) {
      errors.push(`${sourceLabel}: testGlobs must be a non-empty array of glob strings`);
    } else {
      testGlobs = v as string[];
    }
  }

  let ignore: string[] | null = null;
  if ('ignore' in obj) {
    const v = obj.ignore;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      errors.push(`${sourceLabel}: ignore must be an array of strings`);
    } else {
      ignore = v as string[];
    }
  }

  let ignoreWeakOnly = false;
  if ('ignoreWeakOnly' in obj) {
    const v = obj.ignoreWeakOnly;
    if (typeof v !== 'boolean') {
      errors.push(`${sourceLabel}: ignoreWeakOnly must be a boolean (true disables the WEAK_ONLY rule)`);
    } else {
      ignoreWeakOnly = v;
    }
  }

  if (errors.length > 0) return { config: null, errors };

  const base = defaultConfig();
  return {
    config: {
      testGlobs: testGlobs ?? base.testGlobs,
      ignore: ignore ?? base.ignore,
      ignoreWeakOnly,
    },
    errors,
  };
}

export function loadConfigFile(path: string): ConfigLoad {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      config: null,
      errors: [`cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      config: null,
      errors: [`invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (raw === null || raw === undefined) {
    return { config: defaultConfig(), errors: [] };
  }
  return validateConfig(raw, path);
}
