/**
 * Output rendering: table and JSON.
 */
import type { Finding, RuleId } from './detect.js';

export const RULE_IDS: RuleId[] = [
  'NO_ASSERTION',
  'EMPTY_TEST',
  'TAUTOLOGY_LITERAL',
  'WEAK_ONLY',
  'SILENT_CATCH',
  'SNAPSHOT_NOASSERT',
];

export interface ScanMeta {
  command: 'scan' | 'gate';
  filesScanned: number;
  testBlocks: number;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

export function renderTable(findings: Finding[], meta: ScanMeta): string {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push(
      meta.command === 'gate'
        ? 'No vacuous tests introduced by this diff.'
        : 'No vacuous tests found.',
    );
    lines.push(`Scanned ${meta.filesScanned} file(s), ${meta.testBlocks} test block(s).`);
    return lines.join('\n');
  }

  const header = ['LOCATION', 'TEST', 'RULE', 'EVIDENCE'];
  const rows = findings.map((f) => [
    truncate(`${f.file}:${f.line}`, 48),
    truncate(f.test || '(anonymous)', 30),
    f.rule,
    truncate(`${f.evidence} — ${f.why}`, 100),
  ]);

  const widths = header.map((h, i) => Math.min(Math.max(h.length, ...rows.map((r) => r[i].length)) + 2, i === 3 ? 110 : 50));

  const line = (cells: string[]): string =>
    cells.reduce((acc, c, i) => acc + (i === cells.length - 1 ? c : pad(c, widths[i])), '').trimEnd();
  lines.push(line(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join(''));
  for (const r of rows) lines.push(line(r));

  lines.push('');
  const byRule = countByRule(findings);
  lines.push(
    `${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s) — ` +
      `scanned ${meta.filesScanned} file(s), ${meta.testBlocks} test block(s).`,
  );
  for (const rule of RULE_IDS) {
    if (byRule[rule]) lines.push(`  ${pad(rule + ':', 20)} ${byRule[rule]}`);
  }
  return lines.join('\n');
}

export function countByRule(findings: Finding[]): Partial<Record<RuleId, number>> {
  const byRule: Partial<Record<RuleId, number>> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return byRule;
}

export interface JsonOutput {
  version: string;
  command: 'scan' | 'gate';
  findings: Array<{
    file: string;
    line: number;
    evidenceLine: number;
    test: string;
    rule: RuleId;
    evidence: string;
    why: string;
  }>;
  summary: {
    filesScanned: number;
    testBlocks: number;
    findings: number;
    byRule: Partial<Record<RuleId, number>>;
  };
}

export function buildJson(findings: Finding[], meta: ScanMeta, version: string): JsonOutput {
  return {
    version,
    command: meta.command,
    findings: findings.map((f) => ({
      file: f.file,
      line: f.line,
      evidenceLine: f.evidenceLine,
      test: f.test,
      rule: f.rule,
      evidence: f.evidence,
      why: f.why,
    })),
    summary: {
      filesScanned: meta.filesScanned,
      testBlocks: meta.testBlocks,
      findings: findings.length,
      byRule: countByRule(findings),
    },
  };
}
