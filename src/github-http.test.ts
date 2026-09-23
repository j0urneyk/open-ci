import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestGitHubJson, type GitHubTransport } from './github-http.ts';

test('retries transient server errors with bounded exponential backoff', async () => {
  let calls = 0;
  const delays: number[] = [];
  const transport: GitHubTransport = { sleep: async ms => { delays.push(ms); }, fetch: async () => { calls++; return new Response('private payload secret', { status: 503 }); } };
  await assert.rejects(requestGitHubJson('/test', 'synthetic-secret', {}, transport), { message: 'GitHub request failed: HTTP 503.' });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('stops instead of shortening long or unknown server cooldowns', async () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  const cases: Array<{ status: number; headers: Record<string, string> }> = [
    { status: 429, headers: { 'retry-after': '60' } },
    { status: 403, headers: { 'retry-after': '60' } },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) } },
    { status: 429, headers: { 'retry-after': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) } },
    { status: 429, headers: {} },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    { status: 429, headers: { 'retry-after': '-1' } },
    { status: 429, headers: { 'retry-after': 'invalid' } },
    { status: 503, headers: { 'retry-after': '60' } },
  ];
  for (const scenario of cases) {
    let calls = 0;
    const transport: GitHubTransport = {
      now: () => now,
      sleep: async () => assert.fail('must not wait past the retry budget'),
      fetch: async () => { calls++; return new Response('private payload synthetic-secret', scenario); },
    };
    await assert.rejects(requestGitHubJson('/test', 'synthetic-secret', {}, transport), /cooldown/);
    assert.equal(calls, 1, JSON.stringify(scenario));
  }
});

test('honors short Retry-After seconds, HTTP dates, and primary reset deadlines', async () => {
  const start = Date.parse('2026-09-23T00:00:00Z');
  const cases: Array<{ status: number; headers: Record<string, string>; wait: number }> = [
    { status: 429, headers: { 'retry-after': '2' }, wait: 2000 },
    { status: 403, headers: { 'retry-after': '2' }, wait: 2000 },
    { status: 503, headers: { 'retry-after': new Date(start + 4000).toUTCString() }, wait: 4000 },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 3) }, wait: 3000 },
    { status: 429, headers: { 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 2) }, wait: 5000 },
  ];
  for (const scenario of cases) {
    let clock = start;
    let calls = 0;
    const delays: number[] = [];
    const transport: GitHubTransport = {
      now: () => clock,
      sleep: async ms => { delays.push(ms); clock += ms; },
      fetch: async () => {
        if (++calls === 1) return new Response('{}', scenario);
        assert.equal(clock, start + scenario.wait);
        return Response.json({ ready: true });
      },
    };
    const result = await requestGitHubJson('/test', 'token', {}, transport);
    assert.deepEqual(result.data, { ready: true });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [scenario.wait]);
  }
});

test('applies an active cooldown to follow-up requests using the same credential', async () => {
  let clock = Date.parse('2026-09-23T00:00:00Z');
  let calls = 0;
  const transport: GitHubTransport = {
    now: () => clock,
    sleep: async () => assert.fail('must not sleep'),
    fetch: async () => ++calls === 1
      ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } })
      : new Response(null, { status: 204 }),
  };
  await assert.rejects(requestGitHubJson('/test', 'token', {}, transport), /cooldown/);
  await assert.rejects(requestGitHubJson('/installation/token', 'token', { method: 'DELETE' }, transport), /cooldown/);
  assert.equal(calls, 1);
  assert.equal((await requestGitHubJson('/test', 'different-token', {}, transport)).status, 204);
  clock += 60_000;
  assert.equal((await requestGitHubJson('/installation/token', 'token', { method: 'DELETE' }, transport)).status, 204);
  assert.equal(calls, 3);
});

test('does not retry authentication failures or leak response content', async () => {
  let calls = 0;
  const transport: GitHubTransport = { sleep: async () => assert.fail('must not sleep'), fetch: async () => { calls++; return new Response('server echoed synthetic-secret', { status: 401 }); } };
  await assert.rejects(requestGitHubJson('/test', 'synthetic-secret', {}, transport), { message: 'GitHub request failed: HTTP 401.' });
  assert.equal(calls, 1);
});

test('a headerless 403 prevents follow-up requests that could violate secondary limits', async () => {
  let calls = 0;
  const transport: GitHubTransport = {
    now: () => Date.parse('2026-09-23T00:00:00Z'),
    sleep: async () => assert.fail('must not sleep'),
    fetch: async () => { calls++; return Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }); },
  };
  await assert.rejects(requestGitHubJson('/test', 'token', {}, transport), { message: 'GitHub request failed: HTTP 403.' });
  await assert.rejects(requestGitHubJson('/installation/token', 'token', { method: 'DELETE' }, transport), /cooldown/);
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
