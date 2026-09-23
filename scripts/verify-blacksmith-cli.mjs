// Optional contract check: real pinned CLI, local synthetic API, no real account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { runBlacksmithCommand, normalizeBlacksmithUsage } from '../src/blacksmith-runner-usage.ts';

const executable = process.argv[2];
assert.ok(executable, 'Pass the path to a Blacksmith 0.4.60 binary.');
const digests = {
  'darwin-arm64': 'bd273fb9245d116836898fc5880015325d8ac36ccac78df7ffe359424db5b8e3',
  'linux-x64': '5ace4f255ae26b59c230ab8b22ee584f726266d7c1abebda2a953c27224065c0',
};
assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), digests[`${process.platform}-${process.arch}`]);
const start = new Date('2026-09-01T00:00:00Z');
const end = new Date('2026-09-22T00:00:00Z');
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  let payload;
  if (request.url === '/api/cli/verify' || request.url === '/api/cli/whoami') payload = { org: 'example-org', org_name: 'example-org', installation_model_id: 123 };
  else if (request.url.startsWith('/api/cli/installations/123/usage/actions?')) payload = {
    installation: { installation_name: 'example-org', installation_model_id: 123 },
    window: { start: start.toISOString(), end: end.toISOString() },
    summary: { jobs: 1, billable_minutes: 40, billing_minutes: 40, runtime_minutes: 10, cost_usd: 0.06 },
  };
  else { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const directory = await mkdtemp(join(tmpdir(), 'open-ci-cli-contract-'));
try {
  const apiArgs = ['--api-url', `http://127.0.0.1:${server.address().port}`];
  const file = resolve(executable);
  assert.equal((await runBlacksmithCommand(file, ['--version'], directory)).trim(), 'blacksmith version 0.4.60');
  await runBlacksmithCommand(file, [...apiArgs, 'auth', 'login', '--api-token', '-', '--non-interactive', '--organization', 'example-org'], directory, 'synthetic-local-token');
  const output = await runBlacksmithCommand(file, [...apiArgs, 'usage', '--org', 'example-org', '--start-time', start.toISOString(), '--end-time', end.toISOString(), '--format', 'json', '--breakdown-by', 'day'], directory);
  assert.equal(normalizeBlacksmithUsage(JSON.parse(output), 'example-org', start, end), 20);
  const request = new URL(requests.at(-1), 'http://localhost');
  assert.equal(request.searchParams.get('start_time'), start.toISOString());
  assert.equal(request.searchParams.get('end_time'), end.toISOString());
  assert.equal(request.searchParams.get('repo'), null);
  console.log('Blacksmith 0.4.60 local CLI serialization/auth contract passed (synthetic API only).');
} finally {
  await rm(directory, { recursive: true, force: true });
  await new Promise(resolveClose => server.close(resolveClose));
}
