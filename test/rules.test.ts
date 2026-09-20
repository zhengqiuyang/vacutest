import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInSource, type DetectOptions } from '../src/detect.js';

/** Detect on an inline source; return rules fired. */
function rules(src: string, opts?: DetectOptions): string[] {
  return detectInSource(src, 'inline.test.js', opts).findings.map((f) => f.rule);
}

// ----------------------------------------------------------------- NO_ASSERTION

test('NO_ASSERTION fires when the body only runs code without asserting', () => {
  const src = `test('loads config', () => {
    const cfg = load('x.yaml');
    console.log(cfg);
  });`;
  assert.deepEqual(rules(src), ['NO_ASSERTION']);
});

test('NO_ASSERTION fires for a single non-assertion statement', () => {
  assert.deepEqual(rules(`test('noop', () => { const x = 1; });`), ['NO_ASSERTION']);
});

test('NO_ASSERTION does not fire for expect( bodies', () => {
  assert.deepEqual(rules(`test('a', () => { expect(add(1, 2)).toBe(3); });`), []);
});

test('NO_ASSERTION does not fire for assert. bodies', () => {
  assert.deepEqual(rules(`test('a', () => { assert.equal(len('ab'), 2); });`), []);
});

test('NO_ASSERTION does not fire for t.equal bodies', () => {
  assert.deepEqual(rules(`test('a', (t) => { t.equal(1 + 1, 2); });`), []);
});

test('NO_ASSERTION does not fire for should. bodies', () => {
  assert.deepEqual(rules(`test('a', () => { result.should.equal(4); });`), []);
});

test('NO_ASSERTION does not fire for chai .to. bodies', () => {
  assert.deepEqual(rules(`test('a', () => { expect(result).to.have.property('ok'); });`), []);
});

test('NO_ASSERTION does not fire when the body can fail via throw', () => {
  assert.deepEqual(rules(`test('a', () => { if (!ok()) throw new Error('bad'); });`), []);
});

test('NO_ASSERTION does not fire for done() callback style', () => {
  assert.deepEqual(rules(`test('a', (done) => { start(done); });`), []);
});

// ------------------------------------------------------------------- EMPTY_TEST

test('EMPTY_TEST fires for comment-only bodies', () => {
  assert.deepEqual(rules(`it('placeholder', () => { /* TODO */ });`), ['EMPTY_TEST']);
});

test('EMPTY_TEST evidence shows the empty braces', () => {
  const res = detectInSource(`test('p', () => {});`, 'x.test.js');
  assert.equal(res.findings[0].rule, 'EMPTY_TEST');
  assert.equal(res.findings[0].evidence, '{}');
});

test('a one-statement body is NO_ASSERTION, not EMPTY_TEST', () => {
  assert.deepEqual(rules(`it('x', () => { const a = 1; });`), ['NO_ASSERTION']);
});

test('a body with an assertion is never EMPTY_TEST', () => {
  assert.deepEqual(rules(`it('x', () => { expect(add(1, 1)).toBe(2); });`), []);
});

// --------------------------------------------------------------- TAUTOLOGY_LITERAL

test('TAUTOLOGY fires on expect(true).toBe(true)', () => {
  assert.deepEqual(rules(`test('a', () => { expect(true).toBe(true); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on expect(true).toBeTruthy()', () => {
  assert.deepEqual(rules(`test('a', () => { expect(true).toBeTruthy(); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on assert.ok(true)', () => {
  assert.deepEqual(rules(`test('a', () => { assert.ok(true); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on bare assert(true)', () => {
  assert.deepEqual(rules(`test('a', () => { assert(true); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on identical numeric literals', () => {
  assert.deepEqual(rules(`test('a', () => { expect(1).toEqual(1); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on identical string literals', () => {
  assert.deepEqual(rules(`test('a', () => { expect('same').toBe('same'); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on identical string literals with mixed quotes', () => {
  assert.deepEqual(rules(`test('a', () => { expect("s").toBe('s'); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on identical string literals containing braces', () => {
  assert.deepEqual(rules(`test('a', () => { expect('}').toBe('}'); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on same-variable comparisons even after awaits', () => {
  const src = `test('a', async () => {
    const a = await getUser();
    expect(a).toBe(a);
  });`;
  assert.deepEqual(rules(src), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on expect(a).toEqual(a)', () => {
  assert.deepEqual(rules(`test('a', () => { const a = {}; expect(a).toEqual(a); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on assert.equal(v, v)', () => {
  assert.deepEqual(rules(`test('a', () => { const v = f(); assert.equal(v, v); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on t.equal(x, x)', () => {
  assert.deepEqual(rules(`test('a', (t) => { const x = 1; t.equal(x, x); });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY fires on bare a === a comparisons', () => {
  assert.deepEqual(rules(`test('a', () => { if (a === a) { expect(add(1, 1)).toBe(2); } });`), ['TAUTOLOGY_LITERAL']);
});

test('TAUTOLOGY evidence quotes the real comparison (no offset garbling)', () => {
  const findings = detectInSource(
    `test('a', () => { const ok = flag === flag; expect(ok).toBe(true); });`,
    'inline.test.js',
  ).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, 'TAUTOLOGY_LITERAL');
  assert.ok(findings[0]?.evidence.includes('flag === flag'), `evidence: ${findings[0]?.evidence}`);
});

test('TAUTOLOGY does not fire on self-comparison text inside another block\'s string fixture', () => {
  // Found by self-scanning our own meta-test suite (276 false hits): the bare-
  // comparison regex used to run over full-file blanked text, so fixture strings
  // in OTHER test blocks (not blanked for this block's scan) matched and were
  // attributed to whichever block was being analyzed.
  const src = [
    `test('first', () => { expect(add(1, 1)).toBe(2); });`,
    `test('second', () => {`,
    `  const fixture = \`test('inner', () => { if (a === a) { expect(1).toBe(1); } });\`;`,
    `  expect(fixture.length).toBeGreaterThan(0);`,
    `});`,
  ].join('\n');
  assert.deepEqual(rules(src), []);
});

test('TAUTOLOGY does not fire on expect(a).toBe(b)', () => {
  assert.deepEqual(rules(`test('a', () => { const a = 1; const b = 1; expect(a).toBe(b); });`), []);
});

test('TAUTOLOGY does not fire on expect(x).toBe(true)', () => {
  assert.deepEqual(rules(`test('a', () => { const x = f(); expect(x).toBe(true); });`), []);
});

test('TAUTOLOGY does not fire on different literals', () => {
  assert.deepEqual(rules(`test('a', () => { expect(1).toBe(2); expect('a').toBe('b'); });`), []);
});

test('TAUTOLOGY does not fire on assert.ok(value)', () => {
  assert.deepEqual(rules(`test('a', () => { const v = f(); assert.ok(v); });`), []);
});

test('TAUTOLOGY does not fire on a === b', () => {
  assert.deepEqual(rules(`test('a', () => { if (a === b) { expect(add(1, 1)).toBe(2); } });`), []);
});

test('TAUTOLOGY does not fire on same property of one object (getters possible)', () => {
  assert.deepEqual(rules(`test('a', () => { if (cfg.name === cfg.name) { expect(add(1, 1)).toBe(2); } });`), []);
});

test('TAUTOLOGY fires for identical string literals containing comparison text', () => {
  assert.deepEqual(rules(`test('a', () => { expect('a == a').toBe('a == a'); });`), ['TAUTOLOGY_LITERAL']);
});

// Near-miss: the comparison text lives in a string, but the assertion
// compares different values.
test('TAUTOLOGY does not fire on a comparison appearing only in a string', () => {
  assert.deepEqual(rules(`test('a', () => { const s = 'a == a'; expect(s.length).toBe(7); });`), []);
});

// --------------------------------------------------------------------- WEAK_ONLY

test('WEAK_ONLY fires when weak matchers are the only assertions and something happened', () => {
  const src = `test('health', async () => {
    const res = await fetchHealth();
    expect(res).toBeDefined();
  });`;
  assert.deepEqual(rules(src), ['WEAK_ONLY']);
});

test('WEAK_ONLY fires when multiple weak matchers are used together', () => {
  const src = `test('user', () => {
    const u = build();
    expect(u).toBeDefined();
    expect(u).toBeTruthy();
  });`;
  assert.deepEqual(rules(src), ['WEAK_ONLY']);
});

test('WEAK_ONLY fires for assertNotNull-only bodies', () => {
  const src = `test('user', () => {
    const u = build();
    assertNotNull(u);
  });`;
  assert.deepEqual(rules(src), ['WEAK_ONLY']);
});

test('WEAK_ONLY does not fire when a strong matcher is also present', () => {
  const src = `test('health', async () => {
    const res = await fetchHealth();
    expect(res).toBeDefined();
    expect(res.status).toBe(200);
  });`;
  assert.deepEqual(rules(src), []);
});

test('WEAK_ONLY does not fire when nothing happens besides the assertion', () => {
  assert.deepEqual(rules(`test('x', () => { expect(u).toBeDefined(); });`), []);
});

test('WEAK_ONLY does not fire when ignoreWeakOnly is set', () => {
  const src = `test('health', () => {
    const res = fetchHealth();
    expect(res).toBeDefined();
  });`;
  assert.deepEqual(rules(src, { ignoreWeakOnly: true }), []);
});

test('WEAK_ONLY does not fire on unclassifiable chai property chains', () => {
  const src = `test('x', () => {
    const res = fetchHealth();
    expect(res).to.exist;
  });`;
  assert.deepEqual(rules(src), []);
});

test('WEAK_ONLY does not fire when assert-style assertions are mixed in', () => {
  const src = `test('x', () => {
    const res = fetchHealth();
    expect(res).toBeDefined();
    assert.equal(res.status, 200);
  });`;
  assert.deepEqual(rules(src), []);
});

// ------------------------------------------------------------------ SILENT_CATCH

test('SILENT_CATCH fires when assertions live only inside a silent try', () => {
  const src = `test('get', async () => {
    try {
      const res = await call();
      expect(res).toBe(200);
    } catch {}
  });`;
  assert.deepEqual(rules(src), ['SILENT_CATCH']);
});

test('SILENT_CATCH fires for a swallowing try/catch with no assertions', () => {
  const src = `test('get', async () => {
    try {
      await call();
    } catch (e) {
      /* swallow */
    }
  });`;
  assert.deepEqual(rules(src), ['SILENT_CATCH']);
});

test('SILENT_CATCH suppresses the overlapping NO_ASSERTION finding', () => {
  // One finding, the more specific one — not two.
  const src = `test('get', () => { try { call(); } catch {} });`;
  assert.deepEqual(rules(src), ['SILENT_CATCH']);
});

test('SILENT_CATCH does not fire when an assertion runs outside the try', () => {
  const src = `test('throws', () => {
    try {
      boom();
    } catch {}
    expect(() => boom()).toThrow('x');
  });`;
  assert.deepEqual(rules(src), []);
});

test('SILENT_CATCH does not fire when the catch block does something', () => {
  const src = `test('logs', () => {
    let swallowed = null;
    try {
      boom();
    } catch (e) {
      swallowed = e.message;
    }
    assert.equal(swallowed, 'boom');
  });`;
  assert.deepEqual(rules(src), []);
});

test('SILENT_CATCH does not fire when a finally block asserts', () => {
  const src = `test('finally', () => {
    let done = false;
    try {
      boom();
    } catch {}
    finally {
      done = true;
    }
    expect(done).toBe(true);
  });`;
  assert.deepEqual(rules(src), []);
});

// ---------------------------------------------------------------- SNAPSHOT_NOASSERT

test('SNAPSHOT_NOASSERT fires for a mock-named subject', () => {
  const src = `test('snap', () => {
    expect(mockUser).toMatchSnapshot();
  });`;
  assert.deepEqual(rules(src), ['SNAPSHOT_NOASSERT']);
});

test('SNAPSHOT_NOASSERT fires for an object literal subject', () => {
  const src = `test('snap', () => {
    expect({ theme: 'dark' }).toMatchInlineSnapshot();
  });`;
  assert.deepEqual(rules(src), ['SNAPSHOT_NOASSERT']);
});

test('SNAPSHOT_NOASSERT fires for fixture/sample-named subjects', () => {
  assert.deepEqual(rules(`test('s', () => { expect(samplePayload).toMatchSnapshot(); });`), ['SNAPSHOT_NOASSERT']);
  assert.deepEqual(rules(`test('s', () => { expect(fixtureRow).toMatchInlineSnapshot(); });`), ['SNAPSHOT_NOASSERT']);
});

test('SNAPSHOT_NOASSERT does not fire for live-data subjects', () => {
  assert.deepEqual(rules(`test('s', () => { const result = run(); expect(result).toMatchSnapshot(); });`), []);
});

test('SNAPSHOT_NOASSERT does not fire when the snapshot argument is dynamic', () => {
  assert.deepEqual(rules(`test('s', () => { expect(await render()).toMatchSnapshot(); });`), []);
});

test('SNAPSHOT_NOASSERT does not fire when a strong matcher is also present', () => {
  const src = `test('s', () => {
    const html = render();
    expect(html).toMatchSnapshot();
    expect(html).toContain('Total');
  });`;
  assert.deepEqual(rules(src), []);
});

// ------------------------------------------------------------------- interactions

test('TAUTOLOGY suppresses the overlapping WEAK_ONLY finding', () => {
  const src = `test('a', () => {
    const r = compute();
    expect(true).toBeTruthy();
  });`;
  assert.deepEqual(rules(src), ['TAUTOLOGY_LITERAL']);
});

test('each test in a file is analyzed independently', () => {
  const src = `test('bad', () => {});
test('good', () => { expect(add(1, 1)).toBe(2); });
test('bad2', () => { expect(add(1, 1)).toBe(2); assert.equal(len('ab'), 2); });`;
  const res = detectInSource(src, 'x.test.js');
  assert.equal(res.testBlocks, 3);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].test, 'bad');
});
