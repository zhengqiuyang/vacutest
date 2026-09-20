/**
 * vacutest — deterministic detector for vacuous/tautological tests.
 *
 * Design contract (precision-first):
 *  - No AST parser dependency. A lightweight brace-matching tokenizer tracks
 *    parens/braces, strings, template literals, comments and regex literals so
 *    that braces inside strings never break test-block bounds.
 *  - Every rule must be mechanically provable from the source text alone.
 *    Each finding cites file:line, the offending code, and why.
 *  - Anything we cannot classify is treated as "strong" (i.e. clean).
 *    Low recall is acceptable; false positives are not.
 */

export type RuleId =
  | 'NO_ASSERTION'
  | 'EMPTY_TEST'
  | 'TAUTOLOGY_LITERAL'
  | 'WEAK_ONLY'
  | 'SILENT_CATCH'
  | 'SNAPSHOT_NOASSERT';

export interface Finding {
  /** File path as given to detectInSource. */
  file: string;
  /** 1-based line of the `test(`/`it(` declaration. */
  line: number;
  /** 1-based line of the offending code (may equal `line`). */
  evidenceLine: number;
  /** Display name of the test (or a short rendering of the first argument). */
  test: string;
  rule: RuleId;
  /** Offending code excerpt, collapsed to whitespace, <= 100 chars. */
  evidence: string;
  /** Why this is a finding, in one sentence. */
  why: string;
}

export interface DetectOptions {
  /** Disable rule WEAK_ONLY (for teams that accept weak-only assertions). */
  ignoreWeakOnly?: boolean;
}

export interface DetectResult {
  findings: Finding[];
  testBlocks: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Modifiers marking tests that never run in CI — not green-washing, agent-pr-gate's domain. */
const EXCLUDED_MODS = new Set(['skip', 'todo', 'fixme']);

/**
 * Lifecycle-hook modifiers (node:test `test.after(fn)` etc.). These are hooks,
 * not tests: an assertion-free hook is legitimate cleanup, so the call site is
 * not a test block at all.
 */
const HOOK_MODS = new Set(['before', 'after', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

/**
 * Assertion / failure-channel markers. Presence of any of these in a test body
 * suppresses NO_ASSERTION. `throw` and `done(` are failure channels: a body
 * containing them can fail, so calling it vacuous would not be provable.
 */
const ASSERTION_PRESENCE: RegExp[] = [
  /\bexpect\s*\(/,
  /\bassert\s*[\.(]/,
  /\bassertNotNull\s*\(/,
  /\bt\s*\.\s*(?:equal|equals|deepEqual|deepEquals|deepLooseEqual|same|ok|pass|fail|throws|doesNotThrow|is|truthy|falsy|assert|plan)\b/,
  /\bshould\s*\./,
  /\.\s*to\s*\./,
  /\bdone\b/, // callback-style failure channel: done(err) can fail the test
  /\bthrow\b/,
];

/** Weak matchers — pass for almost any code (rule WEAK_ONLY). */
const WEAK_MATCHERS = new Set(['toBeDefined', 'toBeTruthy', 'toBeNull']);

/** Snapshot matchers (rule SNAPSHOT_NOASSERT). */
const SNAPSHOT_MATCHERS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot']);

/** Matchers where identical operands are mechanically always-true. */
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** assert.* methods that compare two operands. */
const ASSERT_EQ_METHODS = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);

/** t.* methods that compare two operands (tape/ava style). */
const T_ASSERT_METHODS = new Set([
  'equal', 'equals', 'deepEqual', 'deepEquals', 'deepLooseEqual', 'same',
  'ok', 'pass', 'fail', 'throws', 'doesNotThrow', 'is', 'truthy', 'falsy', 'assert', 'plan',
]);

/** Keywords after which a `/` starts a regex literal, not a division. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'if', 'while', 'for', 'switch', 'with',
  'catch', 'finally', 'const', 'let', 'var', 'function', 'class', 'extends',
  'import', 'export', 'default',
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type TokenKind = 'ident' | 'num' | 'punct' | 'string' | 'template' | 'comment' | 'regex';

export interface Token {
  kind: TokenKind;
  start: number; // inclusive offset
  end: number; // exclusive offset
  text: string; // raw text
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let prev: Token | null = null; // last non-comment token

  const push = (kind: TokenKind, start: number, end: number): void => {
    const t: Token = { kind, start, end, text: src.slice(start, end) };
    tokens.push(t);
    if (kind !== 'comment') prev = t;
  };

  const regexAllowed = (): boolean => {
    if (!prev) return true;
    if (prev.kind === 'ident') return KEYWORDS_BEFORE_REGEX.has(prev.text);
    if (prev.kind === 'num' || prev.kind === 'string' || prev.kind === 'template') return false;
    // punct: division follows `)` and `]`; a `/` elsewhere starts a regex
    return prev.text !== ')' && prev.text !== ']';
  };

  const scanString = (q: number): number => {
    let j = q + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === src[q]) return j + 1;
      j++;
    }
    return n;
  };

  const scanRegex = (s: number): number => {
    let j = s + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return j; // unterminated: bail at end of line
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && IDENT_CHAR.test(src[j])) j++; // flags
        return j;
      }
      j++;
    }
    return n;
  };

  // Mutual recursion: template literals may contain ${ ... } interpolations
  // that may contain strings/comments/nested templates with braces.
  const scanBraces = (b: number): number => {
    let j = b;
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === '"' || c === "'") { j = scanString(j); continue; }
      if (c === '`') { j = scanTemplate(j); continue; }
      if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e === -1 ? n : e; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e === -1 ? n : e + 2; continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) return j; continue; }
      j++;
    }
    return n;
  };

  const scanTemplate = (s: number): number => {
    let j = s + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') { j = scanBraces(j + 1); continue; }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      push('comment', i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      push('comment', i, end); i = end; continue;
    }
    if (c === '/' && regexAllowed()) {
      const end = scanRegex(i);
      push('regex', i, end); i = end; continue;
    }
    if (c === '"' || c === "'") { const end = scanString(i); push('string', i, end); i = end; continue; }
    if (c === '`') { const end = scanTemplate(i); push('template', i, end); i = end; continue; }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(src[j])) j++;
      push('ident', i, j); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z._$]/.test(src[j])) j++;
      push('num', i, j); i = j; continue;
    }
    if (c === '=' && src[i + 1] === '>') { push('punct', i, i + 2); i += 2; continue; }
    push('punct', i, i + 1);
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const OPENERS = new Set(['(', '[', '{']);
const CLOSER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Index of the token closing the bracket opened at `idx`, or -1. */
function matchBracket(tokens: Token[], idx: number): number {
  const opener = tokens[idx].text;
  let depth = 0;
  for (let k = idx; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (OPENERS.has(t.text)) depth++;
    else if (CLOSER_OF[t.text]) {
      depth--;
      if (depth === 0) return CLOSER_OF[t.text] === opener ? k : -1;
    }
  }
  return -1;
}

function nextSig(tokens: Token[], idx: number): number {
  for (let k = idx + 1; k < tokens.length; k++) if (tokens[k].kind !== 'comment') return k;
  return -1;
}

function prevSig(tokens: Token[], idx: number): number {
  for (let k = idx - 1; k >= 0; k--) if (tokens[k].kind !== 'comment') return k;
  return -1;
}

function textBetween(src: string, tokens: Token[], from: number, to: number): string {
  if (from >= to || from < 0 || to > tokens.length) return '';
  return src.slice(tokens[from].start, tokens[to - 1].end);
}

// ---------------------------------------------------------------------------
// Test-block discovery
// ---------------------------------------------------------------------------

export interface TestCall {
  callStart: number; // offset of the `test`/`it` identifier
  name: string | null;
  bodyStartTok: number; // first token inside the callback body
  bodyEndTok: number; // token index one past the last body token
  bodyStart: number; // char offset of body interior start
  bodyEnd: number; // char offset of body interior end
  hasBraceBody: boolean;
  openTok: number; // token index of the opening `{` (brace bodies)
  closeTok: number; // token index of the closing `}` (brace bodies)
  mods: string[];
}

interface FuncBody {
  bodyStartTok: number;
  bodyEndTok: number;
  hasBraceBody: boolean;
  openTok: number;
  closeTok: number;
}

/** Try to parse the token range [s, e) as a function expression; return its body. */
function parseFunctionBody(src: string, tokens: Token[], s: number, e: number): FuncBody | null {
  if (s >= e) return null;
  let k = s;
  if (tokens[k].kind === 'ident' && tokens[k].text === 'async') k++;
  if (k >= e) return null;

  if (tokens[k].kind === 'ident' && tokens[k].text === 'function') {
    k++;
    if (k < e && tokens[k].kind === 'ident') k++; // optional function name
    if (k < e && tokens[k].kind === 'punct' && tokens[k].text === '(') {
      const close = matchBracket(tokens, k);
      if (close === -1) return null;
      k = close + 1;
    } else {
      return null;
    }
    if (k < e && tokens[k].kind === 'punct' && tokens[k].text === '{') {
      const close = matchBracket(tokens, k);
      if (close === -1) return null;
      return { bodyStartTok: k + 1, bodyEndTok: close, hasBraceBody: true, openTok: k, closeTok: close };
    }
    return null;
  }

  // Arrow function.
  if (k < e && tokens[k].kind === 'punct' && tokens[k].text === '(') {
    const close = matchBracket(tokens, k);
    if (close === -1) return null;
    k = close + 1;
  } else if (k < e && tokens[k].kind === 'ident') {
    k++;
  } else {
    return null;
  }
  if (!(k < e && tokens[k].kind === 'punct' && tokens[k].text === '=>')) return null;
  k++;
  if (k >= e) return null;
  if (tokens[k].kind === 'punct' && tokens[k].text === '{') {
    const close = matchBracket(tokens, k);
    if (close === -1) return null;
    return { bodyStartTok: k + 1, bodyEndTok: close, hasBraceBody: true, openTok: k, closeTok: close };
  }
  // Expression arrow body: everything after `=>`.
  let last = e - 1;
  while (last >= k && tokens[last].kind === 'comment') last--;
  if (last < k) return null;
  return { bodyStartTok: k, bodyEndTok: last + 1, hasBraceBody: false, openTok: -1, closeTok: -1 };
}

export function findTestCalls(src: string, tokens: Token[]): TestCall[] {
  const out: TestCall[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || (t.text !== 'test' && t.text !== 'it')) continue;

    // Skip member accesses: `x.test(`, `foo?.it(`.
    const p = prevSig(tokens, i);
    if (p !== -1 && tokens[p].kind === 'punct' && tokens[p].text === '.') continue;

    // Walk the modifier chain: test.skip(, it.each([...])(, test.concurrent.each`...`(
    const mods: string[] = [];
    let argTok = -1;
    let pos = i;
    let failed = false;
    for (let guard = 0; guard < 24; guard++) {
      const k = nextSig(tokens, pos);
      if (k === -1) { failed = true; break; }
      const tk = tokens[k];
      if (tk.kind === 'punct' && tk.text === '(') { argTok = k; break; }
      if (tk.kind === 'punct' && tk.text === '.') {
        const m = nextSig(tokens, k);
        if (m === -1 || tokens[m].kind !== 'ident') { failed = true; break; }
        mods.push(tokens[m].text);
        const g = nextSig(tokens, m);
        if (g === -1) { failed = true; break; }
        const gt = tokens[g];
        if (gt.kind === 'template') { pos = g; continue; } // it.each`table`(
        if (gt.kind === 'punct' && (gt.text === '[' || gt.text === '{')) {
          const c = matchBracket(tokens, g);
          if (c === -1) { failed = true; break; }
          pos = c;
          continue;
        }
        if (gt.kind === 'punct' && gt.text === '(') {
          if (mods[mods.length - 1] === 'each') {
            // each(...) is the table call, not the test call.
            const c = matchBracket(tokens, g);
            if (c === -1) { failed = true; break; }
            pos = c;
            continue;
          }
          argTok = g;
          break;
        }
        pos = m;
        continue;
      }
      failed = true;
      break;
    }
    if (failed || argTok === -1) continue;
    if (mods.some((m) => HOOK_MODS.has(m))) continue; // lifecycle hook, not a test

    const argClose = matchBracket(tokens, argTok);
    if (argClose === -1) continue;

    // Split top-level argument ranges on commas.
    const commas: number[] = [];
    let depth = 0;
    for (let k = argTok; k <= argClose; k++) {
      const tk = tokens[k];
      if (tk.kind !== 'punct') continue;
      if (OPENERS.has(tk.text)) depth++;
      else if (CLOSER_OF[tk.text]) depth--;
      else if (tk.text === ',' && depth === 1) commas.push(k);
    }
    const starts = [argTok + 1, ...commas.map((c) => c + 1)];
    const ends = [...commas, argClose];
    const ranges: [number, number][] = [];
    for (let b = 0; b < starts.length; b++) ranges.push([starts[b], ends[b]] as [number, number]);
    if (ranges.length === 0) continue;

    // Name: first argument if it is a string/template literal.
    const [ns, ne] = ranges[0];
    let name: string | null = null;
    if (ns < ne) {
      const ft = tokens[ns];
      if (ft.kind === 'string' && ft.text.length >= 2) {
        name = ft.text.slice(1, -1);
      } else if (ft.kind === 'template') {
        name = ft.text.replace(/^`|`$/g, '');
      }
    }

    // Callback: scan arguments from last to first for a function expression
    // (handles `test(name, fn, timeout)` and `test(name, opts, fn)`).
    let body: FuncBody | null = null;
    for (let r = ranges.length - 1; r >= 0; r--) {
      const [rs, re] = ranges[r];
      if (body === null) body = parseFunctionBody(src, tokens, rs, re);
      if (body !== null) break;
    }
    if (body === null) continue;

    if (name === null) {
      const raw = collapse(textBetween(src, tokens, ns, ne)) || '(anonymous)';
      name = raw.length <= 32 ? raw : raw.slice(0, 29) + '...';
    }

    out.push({
      callStart: t.start,
      name,
      bodyStartTok: body.bodyStartTok,
      bodyEndTok: body.bodyEndTok,
      bodyStart: tokens[body.bodyStartTok] ? tokens[body.bodyStartTok].start : src.length,
      bodyEnd: body.bodyEndTok > body.bodyStartTok ? tokens[body.bodyEndTok - 1].end : (tokens[body.bodyStartTok] ? tokens[body.bodyStartTok].start : src.length),
      hasBraceBody: body.hasBraceBody,
      openTok: body.openTok,
      closeTok: body.closeTok,
      mods,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assertion extraction
// ---------------------------------------------------------------------------

interface MatcherCall {
  name: string;
  arg: string | null;
}

interface Assertion {
  root: 'expect' | 'assert' | 't' | 'should' | 'bare-weak';
  start: number;
  end: number;
  /** Inner text of expect(...) — the asserted subject. */
  primaryArg: string | null;
  /** Positional args for method-style roots (assert.equal(a, b)). */
  args: string[];
  /** Method name for method-style roots. */
  method: string | null;
  /** Matcher chain for expect(...) roots. */
  methods: MatcherCall[];
}

function splitArgs(src: string, tokens: Token[], open: number, close: number): string[] {
  const commas: number[] = [];
  let depth = 0;
  for (let k = open; k <= close; k++) {
    const tk = tokens[k];
    if (tk.kind !== 'punct') continue;
    if (OPENERS.has(tk.text)) depth++;
    else if (CLOSER_OF[tk.text]) depth--;
    else if (tk.text === ',' && depth === 1) commas.push(k);
  }
  const starts = [open + 1, ...commas.map((c) => c + 1)];
  const ends = [...commas, close];
  const args: string[] = [];
  for (let b = 0; b < starts.length; b++) {
    const a = textBetween(src, tokens, starts[b], ends[b]).trim();
    args.push(a);
  }
  return args;
}

function extractAssertions(src: string, tokens: Token[], s: number, e: number): Assertion[] {
  const out: Assertion[] = [];
  for (let k = s; k < e; k++) {
    const t = tokens[k];
    if (t.kind !== 'ident') continue;

    if (t.text === 'expect') {
      const o = nextSig(tokens, k);
      if (o === -1 || tokens[o].kind !== 'punct' || tokens[o].text !== '(') continue;
      const c = matchBracket(tokens, o);
      if (c === -1) continue;
      const primaryArg = src.slice(tokens[o].end, tokens[c].start).trim();
      const methods: MatcherCall[] = [];
      let endTok = c;
      let cur = nextSig(tokens, c);
      for (let guard = 0; guard < 32 && cur !== -1; guard++) {
        if (!(tokens[cur].kind === 'punct' && tokens[cur].text === '.')) break;
        const m = nextSig(tokens, cur);
        if (m === -1 || tokens[m].kind !== 'ident') break;
        const nameTok = tokens[m];
        const oo = nextSig(tokens, m);
        if (oo !== -1 && tokens[oo].kind === 'punct' && tokens[oo].text === '(') {
          const cc = matchBracket(tokens, oo);
          if (cc === -1) break;
          methods.push({
            name: nameTok.text,
            arg: src.slice(tokens[oo].end, tokens[cc].start).trim(),
          });
          endTok = cc;
          cur = nextSig(tokens, cc);
        } else {
          endTok = m;
          cur = oo;
        }
      }
      out.push({ root: 'expect', start: t.start, end: tokens[endTok].end, primaryArg, args: [], method: null, methods });
      k = endTok;
      continue;
    }

    if (t.text === 'assert') {
      const o = nextSig(tokens, k);
      if (o === -1) continue;
      if (tokens[o].kind === 'punct' && tokens[o].text === '(') {
        const c = matchBracket(tokens, o);
        if (c === -1) continue;
        const args = splitArgs(src, tokens, o, c);
        out.push({ root: 'assert', start: t.start, end: tokens[c].end, primaryArg: args[0] ?? '', args, method: null, methods: [] });
        k = c;
        continue;
      }
      if (tokens[o].kind === 'punct' && tokens[o].text === '.') {
        const m = nextSig(tokens, o);
        if (m === -1 || tokens[m].kind !== 'ident') continue;
        const oo = nextSig(tokens, m);
        if (oo === -1 || tokens[oo].kind !== 'punct' || tokens[oo].text !== '(') continue;
        const c = matchBracket(tokens, oo);
        if (c === -1) continue;
        const args = splitArgs(src, tokens, oo, c);
        out.push({
          root: 'assert',
          start: t.start,
          end: tokens[c].end,
          primaryArg: args[0] ?? '',
          args,
          method: tokens[m].text,
          methods: [],
        });
        k = c;
        continue;
      }
      continue;
    }

    if (t.text === 't') {
      const o = nextSig(tokens, k);
      if (o === -1 || tokens[o].kind !== 'punct' || tokens[o].text !== '.') continue;
      const m = nextSig(tokens, o);
      if (m === -1 || tokens[m].kind !== 'ident' || !T_ASSERT_METHODS.has(tokens[m].text)) continue;
      const oo = nextSig(tokens, m);
      if (oo === -1 || tokens[oo].kind !== 'punct' || tokens[oo].text !== '(') continue;
      const c = matchBracket(tokens, oo);
      if (c === -1) continue;
      const args = splitArgs(src, tokens, oo, c);
      out.push({
        root: 't',
        start: t.start,
        end: tokens[c].end,
        primaryArg: args[0] ?? '',
        args,
        method: tokens[m].text,
        methods: [],
      });
      k = c;
      continue;
    }

    if (t.text === 'should') {
      const o = nextSig(tokens, k);
      if (o === -1 || tokens[o].kind !== 'punct' || tokens[o].text !== '.') continue;
      const m = nextSig(tokens, o);
      if (m === -1 || tokens[m].kind !== 'ident') continue;
      const oo = nextSig(tokens, m);
      if (oo === -1 || tokens[oo].kind !== 'punct' || tokens[oo].text !== '(') continue;
      const c = matchBracket(tokens, oo);
      if (c === -1) continue;
      const args = splitArgs(src, tokens, oo, c);
      out.push({
        root: 'should',
        start: t.start,
        end: tokens[c].end,
        primaryArg: args[0] ?? '',
        args,
        method: tokens[m].text,
        methods: [],
      });
      k = c;
      continue;
    }

    if (t.text === 'assertNotNull') {
      const o = nextSig(tokens, k);
      if (o === -1 || tokens[o].kind !== 'punct' || tokens[o].text !== '(') continue;
      const c = matchBracket(tokens, o);
      if (c === -1) continue;
      const args = splitArgs(src, tokens, o, c);
      out.push({ root: 'bare-weak', start: t.start, end: tokens[c].end, primaryArg: args[0] ?? '', args, method: null, methods: [] });
      k = c;
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Literal classification (rule TAUTOLOGY_LITERAL)
// ---------------------------------------------------------------------------

type Literal =
  | { kind: 'boolean' | 'null' | 'undefined' | 'number' | 'string'; value: string }
  | { kind: 'ident'; name: string };

export function classifyLiteral(text: string): Literal | null {
  const t = text.trim();
  if (!t) return null;
  if (t === 'true' || t === 'false') return { kind: 'boolean', value: t };
  if (t === 'null') return { kind: 'null', value: 'null' };
  if (t === 'undefined') return { kind: 'undefined', value: 'undefined' };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num)) return { kind: 'number', value: String(num) };
    return null;
  }
  if (
    t.length >= 2 &&
    (t[0] === '"' || t[0] === "'") &&
    t[t.length - 1] === t[0] &&
    !/\\/.test(t.slice(1, -1))
  ) {
    return { kind: 'string', value: t.slice(1, -1) };
  }
  if (t.length >= 2 && t[0] === '`' && t[t.length - 1] === '`' && !t.includes('${')) {
    return { kind: 'string', value: t.slice(1, -1) };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return { kind: 'ident', name: t };
  return null;
}

function literalsEqual(a: Literal, b: Literal): boolean {
  if (a.kind === 'ident' || b.kind === 'ident') {
    return a.kind === b.kind && a.kind === 'ident' && b.kind === 'ident' && (a as { name: string }).name === (b as { name: string }).name;
  }
  return a.kind === b.kind && a.value === b.value;
}

/** Identical identifier both sides, or identical literal both sides. */
function identicalOperands(aText: string | null | undefined, bText: string | null | undefined): { yes: boolean; ident?: string } {
  if (!aText || !bText) return { yes: false };
  const a = classifyLiteral(aText);
  const b = classifyLiteral(bText);
  if (!a || !b) return { yes: false };
  if (a.kind === 'ident' || b.kind === 'ident') {
    if (a.kind === 'ident' && b.kind === 'ident') {
      return a.name === b.name ? { yes: true, ident: a.name } : { yes: false };
    }
    return { yes: false };
  }
  return { yes: literalsEqual(a, b) };
}

// ---------------------------------------------------------------------------
// Rule analysis
// ---------------------------------------------------------------------------

interface Statement {
  startTok: number;
  endTok: number; // exclusive
}

function splitStatements(tokens: Token[], s: number, e: number): Statement[] {
  const out: Statement[] = [];
  let start = s;
  let depth = 0;
  for (let k = s; k < e; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (OPENERS.has(t.text)) { depth++; continue; }
    if (CLOSER_OF[t.text]) { depth--; continue; }
    if (t.text === ';' && depth === 0) {
      if (k > start) out.push({ startTok: start, endTok: k });
      start = k + 1;
    }
  }
  if (e > start) out.push({ startTok: start, endTok: e });
  return out.filter((st) => {
    for (let k = st.startTok; k < st.endTok; k++) {
      const kind = tokens[k].kind;
      if (kind === 'ident' || kind === 'num' || kind === 'string' || kind === 'template') return true;
    }
    return false;
  });
}

/** Body text with comments and string/template/regex contents blanked (lengths preserved). */
function blankedBody(src: string, tokens: Token[], s: number, e: number): string {
  const chars = src.split('');
  for (let k = s; k < e; k++) {
    const t = tokens[k];
    if (t.kind === 'comment' || t.kind === 'string' || t.kind === 'template' || t.kind === 'regex') {
      for (let j = t.start; j < t.end; j++) chars[j] = ' ';
    }
  }
  return chars.join('');
}

/** True if the snapshot subject is static data (mock/fixture ident, literal, no calls). */
function isStaticSnapshotArg(argText: string | null): boolean {
  if (!argText) return false;
  const t = argText.trim();
  if (!t) return false;
  if (t.includes('(')) return false; // any call → dynamic
  if (t.startsWith('{') || t.startsWith('[')) return true; // literal object/array (no calls inside)
  const noAwait = t.replace(/^await\s+/, '');
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(noAwait)) {
    const root = noAwait.split('.')[0];
    return /mock|fixture|sample/i.test(root);
  }
  const lit = classifyLiteral(noAwait);
  return lit !== null && lit.kind !== 'ident';
}

interface TautologyHit {
  start: number;
  end: number;
  why: string;
}

function findTautologies(
  assertions: Assertion[],
  blanked: string,
  bodyStart: number,
  bodyEnd: number,
): TautologyHit[] {
  const hits: TautologyHit[] = [];

  for (const a of assertions) {
    if (a.root === 'expect') {
      const subject = classifyLiteral(a.primaryArg ?? '');
      // expect(true).toBeTruthy()
      if (subject && subject.kind === 'boolean' && subject.value === 'true') {
        if (a.methods.some((m) => m.name === 'toBeTruthy')) {
          hits.push({ start: a.start, end: a.end, why: 'assertion on the literal true — always true' });
        }
      }
      for (const m of a.methods) {
        if (!EQUALITY_MATCHERS.has(m.name)) continue;
        const res = identicalOperands(a.primaryArg, m.arg);
        if (!res.yes) continue;
        hits.push({
          start: a.start,
          end: a.end,
          why: res.ident
            ? `assertion compares ${res.ident} to itself — always true`
            : 'assertion compares identical literals — always true',
        });
        break;
      }
      continue;
    }

    if (a.root === 'assert') {
      // assert.ok(true) / assert(true)
      const arg0 = a.method === 'ok' || a.method === null ? (a.args[0] ?? null) : null;
      if (arg0 !== null) {
        const lit = classifyLiteral(arg0);
        if (lit && lit.kind === 'boolean' && lit.value === 'true') {
          hits.push({ start: a.start, end: a.end, why: 'assertion on the literal true — always true' });
          continue;
        }
      }
      if (a.method !== null && ASSERT_EQ_METHODS.has(a.method)) {
        const res = identicalOperands(a.args[0], a.args[1]);
        if (res.yes) {
          hits.push({
            start: a.start,
            end: a.end,
            why: res.ident
              ? `assertion compares ${res.ident} to itself — always true`
              : 'assertion compares identical literals — always true',
          });
        }
      }
      continue;
    }

    if (a.root === 't' || a.root === 'should') {
      const eqMethods = a.root === 't'
        ? new Set(['equal', 'equals', 'deepEqual', 'deepEquals', 'deepLooseEqual', 'same'])
        : new Set(['equal', 'equals']);
      if (a.method !== null && eqMethods.has(a.method)) {
        const res = identicalOperands(a.args[0], a.args[1]);
        if (res.yes) {
          hits.push({
            start: a.start,
            end: a.end,
            why: res.ident
              ? `assertion compares ${res.ident} to itself — always true`
              : 'assertion compares identical literals — always true',
          });
        }
      }
      continue;
    }
  }

  // Bare identical-operand comparisons: `a === a`, `x == x`, `1 == 1`, `true === true`.
  // Searched on comment/string/template/regex-blanked text (full file, offsets
  // preserved) so literals in strings never match — but the blanking above only
  // covers THIS block's tokens, so gate matches to the block's char range and
  // use absolute offsets. Found by self-scanning our own meta-test suite: the
  // loop used to accept full-file matches (fixture strings in OTHER blocks
  // survived blanking) and double-added bodyStart, garbling the evidence.
  const re = /(?<![\w$.])([\w$]+)\s*[=!]==?\s*(?<![\w$.])\1\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    if (m.index < bodyStart || m.index >= bodyEnd) continue;
    const start = m.index;
    hits.push({
      start,
      end: start + m[0].length,
      why: `comparison of ${m[1]} to itself — always true`,
    });
  }

  return hits;
}

interface CatchAnalysis {
  silentCatch: boolean;
  evidenceStart: number;
  evidenceEnd: number;
}

function findSilentCatch(
  src: string,
  tokens: Token[],
  s: number,
  e: number,
  markerPositions: number[],
): CatchAnalysis | null {
  const trySpans: [number, number][] = [];
  let silent: CatchAnalysis | null = null;
  for (let k = s; k < e; k++) {
    const t = tokens[k];
    if (t.kind !== 'ident' || t.text !== 'try') continue;
    const ob = nextSig(tokens, k);
    if (ob === -1 || tokens[ob].kind !== 'punct' || tokens[ob].text !== '{') continue;
    const cb = matchBracket(tokens, ob);
    if (cb === -1) continue;
    trySpans.push([tokens[ob].start, tokens[cb].end]);
    let nx = nextSig(tokens, cb);
    if (nx === -1 || tokens[nx].kind !== 'ident' || tokens[nx].text !== 'catch') continue;
    nx = nextSig(tokens, nx);
    if (nx !== -1 && tokens[nx].kind === 'punct' && tokens[nx].text === '(') {
      const pc = matchBracket(tokens, nx);
      if (pc === -1) continue;
      nx = nextSig(tokens, pc);
    }
    if (nx === -1 || tokens[nx].kind !== 'punct' || tokens[nx].text !== '{') continue;
    const cc = matchBracket(tokens, nx);
    if (cc === -1) continue;
    // Empty or comment-only catch block?
    let onlyComments = true;
    for (let j = nx + 1; j < cc; j++) {
      if (tokens[j].kind !== 'comment') { onlyComments = false; break; }
    }
    if (onlyComments) {
      silent = { silentCatch: true, evidenceStart: t.start, evidenceEnd: tokens[cc].end };
    }
  }
  if (!silent) return null;
  const outside = markerPositions.some((pos) => !trySpans.some(([ts, te]) => pos >= ts && pos < te));
  return outside ? null : silent;
}

interface RawFinding extends Omit<Finding, 'file' | 'line' | 'evidenceLine'> {
  evidenceStart: number;
}

function analyzeCall(
  src: string,
  tokens: Token[],
  call: TestCall,
  opts: DetectOptions,
): { findings: RawFinding[]; excluded: boolean } {
  if (call.mods.some((m) => EXCLUDED_MODS.has(m))) return { findings: [], excluded: true };

  const { bodyStartTok: s, bodyEndTok: e } = call;
  const bodyText = src.slice(call.bodyStart, call.bodyEnd);
  const findings: RawFinding[] = [];

  // --- EMPTY_TEST: body has no code tokens at all (comments only). ---
  let hasAnyToken = false;
  for (let k = s; k < e; k++) {
    if (tokens[k].kind !== 'comment') { hasAnyToken = true; break; }
  }
  if (!hasAnyToken) {
    const evidence = call.hasBraceBody
      ? src.slice(tokens[call.openTok].start, tokens[call.closeTok].end)
      : bodyText;
    findings.push({
      test: call.name ?? '(anonymous)',
      rule: 'EMPTY_TEST',
      evidence: excerpt(evidence || '{}'),
      why: 'test body is empty — it cannot fail',
      evidenceStart: call.callStart,
    });
    return { findings, excluded: false };
  }

  // --- Assertion / marker presence ---
  const assertions = extractAssertions(src, tokens, s, e);
  const hasMarker = assertions.length > 0 || ASSERTION_PRESENCE.some((re) => re.test(bodyText));
  const markerPositions: number[] = [];
  for (const re of ASSERTION_PRESENCE) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(bodyText)) !== null) {
      markerPositions.push(call.bodyStart + m.index);
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
  }

  // --- TAUTOLOGY_LITERAL ---
  const blanked = blankedBody(src, tokens, s, e);
  const tautologies = findTautologies(assertions, blanked, call.bodyStart, call.bodyEnd);
  for (const hit of tautologies) {
    findings.push({
      test: call.name ?? '(anonymous)',
      rule: 'TAUTOLOGY_LITERAL',
      evidence: excerpt(src.slice(hit.start, hit.end)),
      why: hit.why,
      evidenceStart: hit.start,
    });
  }

  // --- SILENT_CATCH ---
  const silent = findSilentCatch(src, tokens, s, e, markerPositions);
  if (silent) {
    findings.push({
      test: call.name ?? '(anonymous)',
      rule: 'SILENT_CATCH',
      evidence: excerpt(src.slice(silent.evidenceStart, silent.evidenceEnd)),
      why: 'catch swallows errors and no assertion runs outside the try — passes whether or not the code throws',
      evidenceStart: silent.evidenceStart,
    });
  }

  // --- SNAPSHOT_NOASSERT ---
  if (assertions.length > 0) {
    const allSnapshot = assertions.every(
      (a) => a.root === 'expect' && a.methods.length > 0 && a.methods.every((m) => SNAPSHOT_MATCHERS.has(m.name)),
    );
    if (allSnapshot) {
      const allStatic = assertions.every((a) => isStaticSnapshotArg(a.primaryArg));
      if (allStatic) {
        const first = assertions[0];
        findings.push({
          test: call.name ?? '(anonymous)',
          rule: 'SNAPSHOT_NOASSERT',
          evidence: excerpt(src.slice(first.start, first.end)),
          why: 'snapshot of static/mock data — compares a constant to itself',
          evidenceStart: first.start,
        });
      }
    }
  }

  // --- WEAK_ONLY ---
  if (tautologies.length === 0 && !opts.ignoreWeakOnly && assertions.length > 0) {
    const allWeak = assertions.every((a) => {
      if (a.root === 'expect') {
        if (a.methods.length === 0) return false; // unclassifiable chain (e.g. chai property style) → strong
        return a.methods.every((m) => WEAK_MATCHERS.has(m.name));
      }
      return a.root === 'bare-weak'; // assertNotNull
    });
    if (allWeak) {
      // "Something happened": a top-level statement that is not itself an assertion.
      const statements = splitStatements(tokens, s, e);
      const nonAssertion = statements.some((st) => {
        const stStart = tokens[st.startTok].start;
        const stEnd = tokens[st.endTok - 1].end;
        return !assertions.some((a) => a.start < stEnd && stStart < a.end);
      });
      if (nonAssertion) {
        const weak = assertions[0];
        findings.push({
          test: call.name ?? '(anonymous)',
          rule: 'WEAK_ONLY',
          evidence: excerpt(src.slice(weak.start, weak.end)),
          why: 'only weak matchers — these pass for almost any code',
          evidenceStart: weak.start,
        });
      }
    }
  }

  // --- NO_ASSERTION ---
  if (!hasMarker && !silent) {
    let firstStart = call.callStart;
    for (let k = s; k < e; k++) {
      if (tokens[k].kind !== 'comment') { firstStart = tokens[k].start; break; }
    }
    const statements = splitStatements(tokens, s, e);
    let snippet = bodyText.trim();
    if (statements.length > 0) {
      snippet = src.slice(tokens[statements[0].startTok].start, tokens[statements[0].endTok - 1].end);
    }
    findings.push({
      test: call.name ?? '(anonymous)',
      rule: 'NO_ASSERTION',
      evidence: excerpt(snippet),
      why: 'no assertion call in the test body — this test can only fail by throwing',
      evidenceStart: firstStart,
    });
  }

  return { findings, excluded: false };
}

// ---------------------------------------------------------------------------
// Line utilities + public API
// ---------------------------------------------------------------------------

function computeLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function excerpt(s: string, max = 100): string {
  const c = collapse(s);
  if (c.length <= max) return c;
  return c.slice(0, max - 3) + '...';
}

export function detectInSource(source: string, file: string, opts: DetectOptions = {}): DetectResult {
  let src = source;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  src = src.replace(/\r\n?/g, '\n');
  try {
    const tokens = tokenize(src);
    const lineStarts = computeLineStarts(src);
    const calls = findTestCalls(src, tokens);
    const findings: Finding[] = [];
    for (const call of calls) {
      try {
        const res = analyzeCall(src, tokens, call, opts);
        for (const f of res.findings) {
          findings.push({
            ...f,
            file,
            line: lineOf(lineStarts, call.callStart),
            evidenceLine: lineOf(lineStarts, f.evidenceStart),
          });
        }
      } catch {
        // A single unparseable block must never break the scan.
      }
    }
    findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
    return { findings, testBlocks: calls.length };
  } catch (err) {
    return {
      findings: [],
      testBlocks: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
