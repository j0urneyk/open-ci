import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestGitHubJson, type GitHubTransport } from './github-http.ts';

test('retries transient errors but bounds attempts and retry delays', async () => {
  let calls = 0;
  const delays: number[] = [];
  const transport: GitHubTransport = { sleep: async ms => { delays.push(ms); }, fetch: async () => { calls++; return new Response('private payload secret', { status: 429, headers: { 'retry-after': '99999' } }); } };
  await assert.rejects(requestGitHubJson('/test', 'synthetic-secret', {}, transport), { message: 'GitHub request failed: HTTP 429.' });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5000, 5000]);
});

test('does not retry authentication failures or leak response content', async () => {
  let calls = 0;
  const transport: GitHubTransport = { sleep: async () => assert.fail('must not sleep'), fetch: async () => { calls++; return new Response('server echoed synthetic-secret', { status: 401 }); } };
  await assert.rejects(requestGitHubJson('/test', 'synthetic-secret', {}, transport), { message: 'GitHub request failed: HTTP 401.' });
  assert.equal(calls, 1);
});

test('network failures retry, while malformed JSON and redirects fail closed', async () => {
  let calls = 0;
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async (_url, init) => { assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); calls++; throw new Error('token-bearing network error'); } };
  await assert.rejects(requestGitHubJson('/test', 'token', {}, transport), /network failure or timeout/);
  assert.equal(calls, 3);
  await assert.rejects(requestGitHubJson('/test', 'token', {}, { ...transport, fetch: async () => new Response('not-json') }), /expected JSON/);
  await assert.rejects(requestGitHubJson('//attacker.invalid', 'token', {}, transport), /relative/);
});
