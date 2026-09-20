#!/usr/bin/env node
/**
 * vacutest CLI.
 *
 *   vacutest scan [path] [--format table|json] [--config FILE]
 *   vacutest gate --diff <unified.patch> [path] [--format table|json] [--config FILE]
 *
 * Exit codes: 0 clean, 1 findings, 2 usage error.
 */
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { findTestFiles, MAX_FILE_BYTES } from './walk.js';
import { loadConfigFile, defaultConfig, type VacutestConfig } from './config.js';
import { detectInSource, type Finding } from './detect.js';
import { parseUnifiedDiff, diffKey, normalizePath } from './diff.js';
import { renderTable, buildJson } from './report.js';

const VERSION = '0.1.0';

interface ParsedArgs {
  command: string | null;
  path: string;
  format: 'table' | 'json';
  config?: string;
  diff?: string;
  errors: string[];
  help: boolean;
  version: boolean;
}

const USAGE = `vacutest ${VERSION} — deterministic detector for vacuous/tautological tests

Usage:
  vacutest scan [path] [--format table|json] [--config vacutest.yaml]
      Scan test files under path (default: .) and report vacuous tests.
  vacutest gate --diff <unified.patch> [path] [--format table|json] [--config vacutest.yaml]
      Report only findings located on lines ADDED by the given unified diff
      (the pre-gate mode for agent PRs).

Options:
  --format table|json   Output format (default: table)
  --config FILE         Load vacutest.yaml-style config (testGlobs, ignore, ignoreWeakOnly)
  --diff FILE           Unified diff to gate against (gate mode, required)
  -h, --help            Show this help
  -v, --version         Show version

Exit codes: 0 = clean, 1 = findings, 2 = usage error.`;

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    path: '.',
    format: 'table',
    errors: [],
    help: false,
    version: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '-v' || a === '--version') { out.version = true; continue; }
    if (a === '--format' || a === '--config' || a === '--diff') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        out.errors.push(`missing value for ${a}`);
        continue;
      }
      i++;
      if (a === '--format') {
        if (val !== 'table' && val !== 'json') out.errors.push(`invalid --format "${val}" (expected table or json)`);
        else out.format = val as 'table' | 'json';
      } else if (a === '--config') {
        out.config = val;
      } else {
        out.diff = val;
      }
      continue;
    }
    if (a.startsWith('--format=')) {
      const val = a.slice('--format='.length);
      if (val !== 'table' && val !== 'json') out.errors.push(`invalid --format "${val}" (expected table or json)`);
      else out.format = val as 'table' | 'json';
      continue;
    }
    if (a.startsWith('--config=')) { out.config = a.slice('--config='.length); continue; }
    if (a.startsWith('--diff=')) { out.diff = a.slice('--diff='.length); continue; }
    if (a.startsWith('--')) {
      out.errors.push(`unknown option "${a}"`);
      continue;
    }
    positional.push(a);
  }
  out.command = positional[0] ?? null;
  if (positional.length > 2) out.errors.push(`unexpected extra argument "${positional[2]}"`);
  if (positional.length >= 2) out.path = positional[1];
  return out;
}

function fail(msgs: string[]): never {
  for (const m of msgs) console.error(`vacutest: ${m}`);
  console.error(`vacutest: usage error — see --help`);
  process.exit(2);
}

interface ScanOutcome {
  findings: Finding[];
  filesScanned: number;
  testBlocks: number;
}

function scanTree(rootArg: string, cfg: VacutestConfig, displayRoot: string): ScanOutcome {
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    return fail([`path does not exist: ${rootArg}`]);
  }

  let files: string[];
  if (st.isFile()) {
    files = [root];
  } else if (st.isDirectory()) {
    files = findTestFiles(root, { testGlobs: cfg.testGlobs, ignore: cfg.ignore });
  } else {
    return fail([`path is not a file or directory: ${rootArg}`]);
  }

  const findings: Finding[] = [];
  let testBlocks = 0;
  for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      console.error(`vacutest: warning: cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (content.includes('\u0000')) continue; // binary
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      console.error(`vacutest: warning: skipping ${abs} (>2MB)`);
      continue;
    }
    const display = displayFile(abs, root);
    const res = detectInSource(content, display, { ignoreWeakOnly: cfg.ignoreWeakOnly });
    if (res.error) console.error(`vacutest: warning: could not analyze ${display}: ${res.error}`);
    findings.push(...res.findings);
    testBlocks += res.testBlocks;
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { findings, filesScanned: files.length, testBlocks };
}

function displayFile(abs: string, root: string): string {
  const relPath = relative(root, abs).split(sep).join('/');
  return relPath && !relPath.startsWith('..') ? relPath : abs.split(sep).join('/');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.errors.length > 0) fail(args.errors);

  const command = args.command;
  if (command !== 'scan' && command !== 'gate') {
    fail([command === null ? 'missing command' : `unknown command "${command}" (expected scan or gate)`]);
  }

  // Config
  let cfg = defaultConfig();
  if (args.config) {
    const loaded = loadConfigFile(args.config);
    if (loaded.errors.length > 0 || loaded.config === null) {
      fail(loaded.errors.length > 0 ? loaded.errors : ['invalid config file']);
    }
    cfg = loaded.config;
  }

  // Gate requires a diff
  let diffText: string | null = null;
  if (command === 'gate') {
    if (!args.diff) fail(['gate requires --diff <unified.patch>']);
    try {
      diffText = readFileSync(args.diff, 'utf8');
    } catch (err) {
      fail([`cannot read diff file ${args.diff}: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  const outcome = scanTree(args.path, cfg, args.path);
  let findings = outcome.findings;

  if (command === 'gate' && diffText !== null) {
    const added = parseUnifiedDiff(diffText);
    findings = findings.filter((f) => {
      const key = diffKey(normalizePath(f.file));
      const set = added.get(key);
      if (!set) return false;
      return set.has(f.line) || set.has(f.evidenceLine);
    });
  }

  const meta = { command, filesScanned: outcome.filesScanned, testBlocks: outcome.testBlocks } as const;
  if (args.format === 'json') {
    console.log(JSON.stringify(buildJson(findings, meta, VERSION), null, 2));
  } else {
    console.log(renderTable(findings, meta));
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

main();
