/**
 * Shared helpers for vacutest's own test suite.
 * Lives in dist/test but is not a *.test.js, so node --test never runs it directly.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], opts: { cwd?: string } = {}): CliResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Unified diff inserting `added` lines before index `at` of `lines`.
 * Mirrors what `git diff` emits for a pure insertion.
 */
export function makeInsertionPatch(file: string, lines: string[], at: number, added: string[], ctx = 3): string {
  const start = Math.max(0, at - ctx);
  const end = Math.min(lines.length, at + ctx);
  const oldCount = end - start;
  const newCount = oldCount + added.length;
  const oldStart = lines.length === 0 ? 0 : start + 1;
  const newStart = lines.length === 0 ? 1 : start + 1;
  const out: string[] = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ];
  for (let i = start; i < at; i++) out.push(' ' + lines[i]);
  for (const l of added) out.push('+' + l);
  for (let i = at; i < end; i++) out.push(' ' + lines[i]);
  return out.join('\n') + '\n';
}

/** Unified diff replacing line `idx` (0-based) of `lines` with `newLine`. */
export function makeReplacePatch(file: string, lines: string[], idx: number, oldLine: string, newLine: string, ctx = 3): string {
  const start = Math.max(0, idx - ctx);
  const end = Math.min(lines.length, idx + ctx + 1);
  const count = end - start;
  const lineStart = start + 1;
  const out: string[] = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${lineStart},${count} +${lineStart},${count} @@`,
  ];
  for (let i = start; i < idx; i++) out.push(' ' + lines[i]);
  out.push('-' + oldLine);
  out.push('+' + newLine);
  for (let i = idx + 1; i < end; i++) out.push(' ' + lines[i]);
  return out.join('\n') + '\n';
}
