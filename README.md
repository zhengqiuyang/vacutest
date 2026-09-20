# vacutest

**A deterministic detector for vacuous and tautological tests — the 2-second pre-gate before mutation testing.**

Agents write most of the tests now, and agents have discovered the easiest way to make CI green is to write tests that cannot fail. `vacutest` catches the mechanically provable cases: tests that assert nothing, assert the obvious, compare a value to itself, or swallow the errors they were supposed to check.

- **High precision, low recall.** Every rule is mechanically provable from the source text. If we cannot justify a finding in two lines, the rule does not ship. No scores, no percentages — just findings with evidence.
- **Per-test evidence.** Every finding cites `file:line`, the offending code, and a one-sentence *why*. You can paste it straight into a PR comment.
- **Diff gating.** `vacutest gate` reports only findings on lines *added* by a diff — the right shape for reviewing agent PRs, where pre-existing debt is not the PR's fault.
- **Fast and boring.** No AST parser dependency, no test execution, no network. A lightweight brace-matching scanner that runs over a repo in about two seconds.

```
LOCATION        TEST                        RULE               EVIDENCE
----------------------------------------------------------------------------------------------
all.test.js:5   health endpoint responds    WEAK_ONLY          expect(res).toBeDefined() — only weak
                                                                 matchers — these pass for almost any code
all.test.js:14  config roundtrip is stable  TAUTOLOGY_LITERAL  expect(cfg).toBe(cfg) — assertion compares
                                                                 cfg to itself — always true
```

## The story

AI agents now write most test code, and review bandwidth has not scaled with them. The result is green-washing: PRs arrive with dozens of new tests that all pass — because they can never fail. A skipped test is the lazy version (our sibling tool [agent-pr-gate](https://github.com/) already scans diffs for those); the dangerous version is a test that *exists*, *runs*, and *asserts nothing*.

The honest, complete answer to "do these tests actually test anything?" is [mutation testing](https://stryker-mutator.io/) — Stryker for JavaScript is excellent, and incremental mode has made it practical at repo scale. But mutation testing remains a nightly-tier job: too slow and too opaque to run per-PR, and it tells you *a mutant survived*, not *which line of which test is a lie*.

**vacutest is not a replacement for mutation testing. It is the 2-second pre-gate that runs in front of it.** It catches the provable subset instantly, with per-test explanations an agent can act on immediately, and lets mutation testing spend its budget on the subtle cases.

> vacutest comes out of the same family as **agent-pr-gate** (which scans diffs for *skipped* tests). vacutest extends the same philosophy to tests that exist but assert nothing.

## Install

```bash
npm install --save-dev vacutest   # or: npx vacutest scan
```

Requires Node 20+. Runtime dependency: `yaml` (for config). No AST parser, ever — precision comes from conservative patterns, not parsing depth.

## Usage

```bash
# Scan a repo (recursive; skips node_modules/dist/.git by default)
vacutest scan [path] [--format table|json] [--config vacutest.yaml]

# Gate a PR: only findings on lines ADDED by the diff
vacutest gate --diff <unified.patch> [path] [--format table|json] [--config vacutest.yaml]
```

Exit codes: `0` clean, `1` findings, `2` usage error — designed for CI.

```yaml
# .github/workflows/vacutest.yml  (the whole integration)
- run: git diff --unified=0 origin/main...HEAD > pr.patch
- run: npx vacutest gate --diff pr.patch .
```

### Configuration (`vacutest.yaml`)

```yaml
testGlobs:            # which files are test files (defaults below)
  - "**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"
  - "**/*.spec.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"
  - "**/test/**/*.{js,mjs,cjs,ts}"
  - "**/tests/**/*.{js,mjs,cjs,ts}"
  - "**/__tests__/**/*.{js,mjs,cjs,ts}"
ignore:               # extra dirs/patterns to prune (node_modules/.git/dist always pruned)
  - "vendor"
ignoreWeakOnly: false # set true to disable the WEAK_ONLY rule if your team accepts them
```

Unknown keys and wrong types produce accumulated validation errors, not surprises.

## The rules (the precision contract)

All findings are equal — findings, not scores. For every rule, here is exactly what fires and what does not. Anything we cannot classify counts as *strong* (clean).

### 1. `EMPTY_TEST` — the test body has no statements

| FIRES | DOES NOT FIRE |
|---|---|
| `test('x', () => { /* TODO */ });` | `test('x', () => { const a = 1; });` (that's `NO_ASSERTION`) |

### 2. `NO_ASSERTION` — the body contains zero assertion/failure calls

Markers: `expect(`, `assert.`/`assert(`, `assertNotNull(`, tape-style `t.equal`-family, `should.`, chai `.to.`, plus the failure channels `done` and `throw` (a body that can fail by throwing or calling `done(err)` is not provably vacuous).

| FIRES | DOES NOT FIRE |
|---|---|
| `const r = run(); console.log(r);` | `expect(run()).toBe(3);` |
| | `assert.equal(n, 3);` / `t.equal(n, 3);` |
| | `if (!ok) throw new Error('bad');` |
| | `start(done);` (callback style) |

### 3. `TAUTOLOGY_LITERAL` — the assertion is provably always true

Identical literals on both sides, literal `true` asserted, or the same identifier compared to itself. Also bare `a === a`-style comparisons in code (strings/comments excluded; `x.a === x.a` is *not* reported — getters make it unprovable).

| FIRES | DOES NOT FIRE |
|---|---|
| `expect(true).toBe(true);` / `expect(true).toBeTruthy()` | `expect(x).toBe(true);` |
| `assert.ok(true);` / `assert(true);` | `assert.ok(value);` |
| `expect(1).toEqual(1);` / `expect('a').toBe('a')` | `expect(1).toBe(2);` |
| `expect(user).toBe(user);` (even if `user` came from an `await`) | `expect(a).toBe(b);` |
| `assert.equal(v, v);` / `t.equal(x, x);` | `assert.equal(a, b);` |
| `if (a === a) { ... }` | `if (a === b) { ... }` / `if (cfg.name === cfg.name)` |

Known limit, documented rather than hidden: for *bare* `a === a` comparisons, `NaN` is the one value where the comparison is false; we treat that as out of scope for literal-level analysis (matcher forms use `Object.is`/deep-equality semantics where `NaN` equals `NaN`).

### 4. `WEAK_ONLY` — the only assertions are weak matchers, and something happened

Weak set: `toBeDefined`, `toBeTruthy`, `toBeNull`, `assertNotNull`. If *any* strong matcher (`toBe`, `toEqual`, `toStrictEqual`, `toContain`, `toMatch` (non-snapshot), `toHaveBeenCalledWith`, `toHaveLength`, `toThrow`, `assert.equal/deepEqual/strictEqual/throws`, `t.equal/deepEqual`, `should.equal`, … or anything unclassified) appears in the same block, the block is clean. The block must also contain at least one non-assertion statement ("something happened") — a lone weak assertion is reported only when it is the *cover* for real work. Disable per-team with `ignoreWeakOnly: true`.

| FIRES | DOES NOT FIRE |
|---|---|
| `const res = await check(); expect(res).toBeDefined();` | `expect(res).toBeDefined(); expect(res.status).toBe(200);` |
| `const u = build(); assertNotNull(u);` | `test('x', () => { expect(u).toBeDefined(); });` (nothing happened) |
| | `expect(res).to.exist;` (unclassifiable chai chain → strong) |

### 5. `SILENT_CATCH` — errors swallowed, nothing asserts outside the try

Fires when a `catch` block is empty (or comment-only) **and** no assertion/failure marker appears outside the `try` in the test body. An assertion inside the `try` makes it *worse*, not better: on the throwing path the catch swallows and the test still passes.

| FIRES | DOES NOT FIRE |
|---|---|
| `try { await run(); expect(n).toBe(1); } catch {}` | `try { run(); } catch {} expect(() => run()).toThrow('x');` |
| `try { await run(); } catch (e) { /* swallow */ }` | `catch (e) { swallowed = e.message; }` + assert after |
| | `try { run(); } catch {} finally { ... } assert(...)` |

### 6. `SNAPSHOT_NOASSERT` — a snapshot of static/mock data

Fires when snapshot matchers (`toMatchSnapshot` / `toMatchInlineSnapshot`) are the *only* assertions and every snapshot subject is static: an object/array literal, a primitive literal, or an identifier rooted at something named `mock*`/`fixture*`/`sample*`.

| FIRES | DOES NOT FIRE |
|---|---|
| `expect(mockUser).toMatchSnapshot();` | `expect(render()).toMatchSnapshot();` (live data) |
| `expect({ theme: 'dark' }).toMatchInlineSnapshot();` | `expect(html).toMatchSnapshot(); expect(html).toContain('Total');` |
| | `expect(await build()).toMatchSnapshot();` (dynamic) |

### What we deliberately do *not* flag

- `test.skip` / `test.todo` / `test.fixme` blocks — a skipped test is visible in CI, not green-washing. That's agent-pr-gate's diff-scanning job.
- Tests whose only failure channel is `throw`/`done(err)` — they can fail, so calling them vacuous would not be provable.
- Weak assertions mixed with any strong one — see rule 4.
- Anything requiring type inference, inter-procedural analysis, or execution. That's mutation testing's job.

## Philosophy

**Mechanically provable only.** We will never ship a heuristic we cannot justify with two lines: "the left operand and the right operand are the same identifier" or "the catch block is empty and no assertion exists outside the try". If a human reviewer could argue with the finding, it does not ship.

**Low recall is a feature.** vacutest is a gate that runs on every PR. A gate with false positives gets disabled within a week; a gate that catches 80% of the provable cases and never lies keeps running for years. Every unclassifiable construct defaults to *clean*.

**Findings, not scores.** Numbers invite thresholds, thresholds invite gaming, and gaming is exactly the failure mode we exist to prevent.

## Competitive landscape

- **Mutation testing (Stryker, Pitest, mutmut)** — the gold standard for "does this test suite detect anything", and the tool we complement. Still too slow for per-PR gating in most repos, incremental mode included, and its output ("1 mutant survived at src/fix.ts:42") does not name the lying test line. We are the cheap pre-gate; it stays the deep audit. Use both.
- **Qodo (formerly CodiumAI), CoverAgent and test-generation tools** — focused on coverage and generation; coverage cannot see a tautology (a vacuous test covers code perfectly).
- **Sonar/lint rules** — shallow, name-based heuristics (e.g. "empty test detected"), not deterministic operand-level analysis, and no diff-gating mode.
- **A July-2026 academic vacuous-test detector exists** — proof the category is real, and a reason to move fast on the diff-gating wedge, which is where the agent-PR workflow actually lives.

## Kill criteria

We are a precision tool, and a precision tool must be honest about when it has failed:

1. **False-positive rate.** If vacutest cannot stay at effectively-zero false positives on hand-written suites (our gauntlet: the eight sibling repos in this workspace, all green as of 0.1.0), the tool is miscalibrated — fix precision or archive.
2. **Upstream consolidation.** If Stryker (or an equivalent) ships a per-PR-fast mode with per-test explanations, the pre-gate wedge closes — fold the diff-gating UX into agent-pr-gate and archive this repo.
3. **Adoption.** If by 0.3 the tool is not blocking real agent PRs in at least three repos, the problem was not as common as the research said.

## Roadmap

- **AST mode** (optional `typescript` peer dependency) — same rules, richer block discovery; the scanner stays the default so vacutest stays dependency-light.
- **Python support** — `pytest`/`unittest` dialects for the same rule set.
- **agent-pr-gate integration hook** — one gate config that runs skipped-test scanning (agent-pr-gate) and vacuous-test scanning (vacutest) over the same diff.
- **SARIF output** for GitHub code scanning.

## Development

```bash
npm install
npm test      # builds (tsc) first, then runs the node:test suite via run-tests.mjs
npm run demo  # fixture suite + scan + gate walkthrough
```

Tests are fixture-driven and offline. The precision suite (`test/rules.test.ts`) is the contract: for each rule, vacuous fixtures that must fire and benign near-misses that must not.

MIT license. See [LICENSE](LICENSE).
