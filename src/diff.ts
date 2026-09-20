/**
 * Unified diff parsing for `vacutest gate`: map ADDED lines to (file, line number).
 */

/** Normalized posix path -> set of 1-based line numbers added in the new file. */
export function parseUnifiedDiff(text: string): Map<string, Set<number>> {
  const norm = text.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  const map = new Map<string, Set<number>>();

  let file: string | null = null;
  let inHunk = false;
  let newLine = 0;

  const add = (f: string, ln: number): void => {
    let set = map.get(f);
    if (!set) {
      set = new Set<number>();
      map.set(f, set);
    }
    set.add(ln);
  };

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('Index:')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      let p = line.slice(4).trim();
      if (p === '/dev/null') {
        file = null;
        continue;
      }
      if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
        p = p.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      if (p.startsWith('b/')) p = p.slice(2);
      file = normalizePath(p);
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLine = m ? parseInt(m[1], 10) : 1;
      inHunk = true;
      continue;
    }
    if (inHunk && file !== null) {
      if (line.startsWith('+')) {
        add(file, newLine);
        newLine++;
      } else if (line.startsWith('-')) {
        // old-file line only
      } else if (line.startsWith(' ') || line === '') {
        newLine++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file"
      } else {
        inHunk = false; // garbage line ends the hunk
      }
    }
  }
  return map;
}

export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Lowercased key for cross-platform path comparison. */
export function diffKey(p: string): string {
  return normalizePath(p).toLowerCase();
}
