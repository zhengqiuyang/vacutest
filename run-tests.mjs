// vacutest test runner.
// Enumerates dist/test/*.test.js explicitly (glob args to `node --test` need Node 21+)
// and strips runner-injected env vars that have burned us on sibling repos
// (CI injects GITHUB_* credentials and event payloads that flip error-path tests).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, 'dist', 'test');

let files;
try {
  files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => join('dist', 'test', f));
} catch {
  console.error('dist/test not found — run `npm run build` first.');
  process.exit(1);
}

if (files.length === 0) {
  console.error('no test files found in dist/test — run `npm run build` first.');
  process.exit(1);
}

const env = { ...process.env };
delete env.GITHUB_EVENT_PATH;
delete env.GITHUB_TOKEN;
delete env.GH_TOKEN;

console.error(`running ${files.length} test file(s): ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
const res = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env,
  cwd: root,
});
process.exit(res.status ?? (res.error ? 1 : 0));
