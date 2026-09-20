// The near-miss battery: every test here is benign and must produce ZERO findings.
// This file is the precision contract in executable form.

test('strong assertion', () => {
  expect(add(1, 2)).toBe(3);
});

test('weak plus strong', () => {
  const res = check();
  expect(res).toBeDefined();
  expect(res.status).toBe(200);
});

test('weak null plus strong contain', () => {
  const res = check();
  expect(res.error).toBeNull();
  expect(res.body).toContain('ok');
});

test('assert style', () => {
  assert.equal(len('ab'), 2);
});

test('assert deep', () => {
  assert.deepEqual([2, 1].sort(), [1, 2]);
});

test('assert throws', () => {
  assert.throws(() => boom());
});

test('t style', (t) => {
  t.equal(1 + 1, 2);
});

test('throws outside try is clean', () => {
  try {
    boom();
  } catch {}
  expect(() => boom()).toThrow('boom');
});

test('catch that records is not silent', () => {
  let swallowed = null;
  try {
    boom();
  } catch (e) {
    swallowed = e.message;
  }
  assert.equal(swallowed, 'boom');
});

test('assertion inside catch is fine', () => {
  try {
    boom();
  } catch (e) {
    assert.equal(e.message, 'boom');
  }
});

test('snapshot plus strong matcher', () => {
  const html = render();
  expect(html).toMatchSnapshot();
  expect(html).toContain('Total');
});

test('snapshot of live data', () => {
  const result = runPipeline();
  expect(result).toMatchSnapshot();
});

test('different variables compared', () => {
  const a = build();
  const b = build();
  expect(a).toEqual(b);
});

test('variable vs literal is not a tautology', () => {
  const ok = verify();
  expect(ok).toBe(true);
});

test('same property on both sides is not reported', () => {
  const cfg = load();
  if (cfg.name === cfg.name) {
    expect(cfg.name).toContain('v');
  }
});

test('strings with braces do not break bounds', () => {
  expect('}{'.length).toBe(2);
  expect(`${'{'} and ${'}'}`).toContain('and');
});

test('template interpolation with nested template', () => {
  const inner = `x${1 + 1}`;
  const outer = `a ${inner} b`;
  expect(outer).toBe('a x2 b');
});

test('regex literal with braces and quotes', () => {
  expect('a{b}"c'.replace(/[{}"]/g, '')).toBe('abc');
});

test('comment with fake test call', () => {
  // test('fake', () => { expect(1).toBe(1); });
  /* it('also fake', () => {}) */
  expect(2).toBe(1 + 1);
});

test('expression arrow body with assertion', () => expect(add(2, 2)).toBe(4));

test('async function callback', async function () {
  const v = await add(1, 1);
  assert.equal(v, 2);
});

test('done callback style', (done) => {
  setTimeout(() => done(), 0);
});

test('each wrapper with real assertion', () => {
  const rows = [[1, 2, 3], [2, 3, 5]];
  for (const [a, b, sum] of rows) {
    assert.equal(add(a, b), sum);
  }
});

function add(a, b) { return a + b; }
function len(s) { return s.length; }
function boom() { throw new Error('boom'); }
function check() { return { status: 200, body: 'ok', error: null }; }
function render() { return '<html>Total: 3</html>'; }
function runPipeline() { return { steps: 3 }; }
function build() { return { id: 1 }; }
function verify() { return true; }
function load() { return { name: 'v1' }; }
