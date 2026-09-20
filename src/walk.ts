/**
 * File walking + glob matching. Runtime deps: none (only node builtins).
 */
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface WalkConfig {
  testGlobs: string[];
  ignore: string[];
}

/** Directories always pruned (minimal .gitignore respect). */
export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.turbo', '.output',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Glob → anchored RegExp. Supports `**`, `*`, `?`, and `{a,b}` alternation. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        re += escapeRegex(c);
      } else {
        const body = glob.slice(i + 1, close);
        const parts = body.split(',').map((p) => globToRegex(p).source.replace(/^\^|\$$/g, ''));
        re += `(?:${parts.join('|')})`;
        i = close;
      }
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        re += escapeRegex(c);
      } else {
        re += glob.slice(i, close + 1);
        i = close;
      }
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isIgnored(relPosix: string, patterns: string[], isDir: boolean): boolean {
  const segments = relPosix.split('/');
  for (const p of patterns) {
    if (!p) continue;
    if (!p.includes('/') && !p.includes('*') && !p.includes('{')) {
      // Plain name: matches any path segment (typically a directory name).
      if (segments.some((sg) => sg === p)) return true;
    } else {
      const re = globToRegex(p);
      if (re.test(relPosix)) return true;
      if (isDir && re.test(relPosix + '/**')) return true;
    }
  }
  return false;
}

/** Recursively find files under `root` matching testGlobs. Returns absolute paths, sorted. */
export function findTestFiles(root: string, cfg: WalkConfig): string[] {
  const matchers = cfg.testGlobs.map(globToRegex);
  const results: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 64) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const relPosix = toPosix(relative(root, full));
      if (ent.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
        if (isIgnored(relPosix, cfg.ignore ?? [], true)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (isIgnored(relPosix, cfg.ignore ?? [], false)) continue;
        if (matchers.some((m) => m.test(relPosix))) results.push(full);
      }
      // symlinks and other types are skipped (loop safety)
    }
  };

  walk(root, 0);
  return results.sort();
}

export { MAX_FILE_BYTES };
