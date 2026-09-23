import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGitHubRunner, isStandardGitHubRunner, normalizeGitHubUsage } from './github-runner-usage.ts';
import { resolveRunnerConfig } from './runner-config.ts';
import type { GitHubTransport } from './github-http.ts';
import type { CallerRepository } from './runner-contract.ts';

const now = new Date('2026-09-22T12:00:00Z');
const caller: CallerRepository = { owner: 'example-org', name: 'app', visibility: 'private', sha: 'a'.repeat(40) };
const config = () => resolveRunnerConfig({ priority: ['github'], providers: { github: { 'runs-on': 'ubuntu-latest', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' }, 'sku-minute-multipliers': { actions_linux: 1, actions_windows: 2, actions_macos: 10, linux_8_core: 0 } } } }, {}).providers.github!;
const report = (items: unknown[]) => ({ organization: 'example-org', timePeriod: { year: 2026, month: 9 }, usageItems: items });
const row = (sku: string, quantity: number) => ({ product: 'Actions', unitType: 'minutes', sku, grossQuantity: quantity, netQuantity: 0, discountQuantity: quantity });
const token = { token: 'synthetic-billing-token', appId: '', privateKey: '' };

test('classifies documented standard labels only, never custom groups or larger suffixes', () => {
  for (const target of ['ubuntu-latest', ['ubuntu-24.04'], { labels: 'windows-2025' }]) assert.equal(isStandardGitHubRunner(target), true);
  for (const target of ['ubuntu-latest-8core', 'custom-runner', { group: 'larger', labels: 'ubuntu-latest' }, ['ubuntu-latest', 'gpu'], 'macos-latest-large']) assert.equal(isStandardGitHubRunner(target), false);
});

test('public standard runners and unverified targets never query billing', async () => {
  const transport: GitHubTransport = { fetch: async () => { throw new Error('must not fetch'); }, sleep: async () => {} };
  assert.equal((await evaluateGitHubRunner(config(), { ...caller, visibility: 'public' }, { ...token, token: '' }, now, transport)).state, 'available');
  assert.equal((await evaluateGitHubRunner({ ...config(), 'runs-on': { group: 'paid' } }, caller, token, now, transport)).state, 'unavailable');
});

test('normalizes private repository gross quantities with explicitly supplied conversion factors', () => {
  const payload = report([row('actions_linux', 100), row('actions_windows', 50), row('actions_macos', 10), row('linux_8_core', 500)]);
  assert.equal(normalizeGitHubUsage(payload, caller.owner, 2026, 9, config()['sku-minute-multipliers']), 300);
  assert.equal(normalizeGitHubUsage(report([]), caller.owner, 2026, 9, {}), 0);
});

test('organization identity is case-insensitive without accepting a different or missing owner', () => {
  assert.equal(normalizeGitHubUsage({ ...report([row('actions_linux', 42)]), organization: 'EXAMPLE-ORG' }, caller.owner, 2026, 9, config()['sku-minute-multipliers']), 42);
  for (const organization of [undefined, 1, 'different-org']) assert.throws(() => normalizeGitHubUsage({ ...report([]), organization }, caller.owner, 2026, 9, {}), /organization/);
});

test('rejects incomplete, wrong-period, unknown-SKU or malformed usage instead of undercounting', () => {
  for (const payload of [
    {}, { ...report([]), organization: 'another-org' }, { ...report([]), timePeriod: { year: 2026, month: 8 } },
    report([row('new_minute_sku', 10)]), report([{ ...row('actions_linux', 10), unitType: 'seconds' }]),
    report([{ ...row('actions_linux', 10), grossQuantity: '10' }]), report([row('actions_linux', -1)]),
  ]) assert.throws(() => normalizeGitHubUsage(payload, caller.owner, 2026, 9, config()['sku-minute-multipliers']));
});

test('excludes public repository usage and aggregates every private billed repository', async () => {
  const paths: string[] = [];
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async input => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith('/usage')) return Response.json({ usageItems: ['app', 'worker', 'public-docs'].map(repositoryName => ({ product: 'Actions', unitType: 'Minutes', sku: 'Actions Linux', organizationName: 'example-org', repositoryName })) });
    if (url.pathname.startsWith('/repos/')) {
      const name = url.pathname.split('/').at(-1)!;
      return Response.json({ full_name: `example-org/${name}`, private: name !== 'public-docs' });
    }
    const repository = url.searchParams.get('repository');
    if (repository === 'example-org/app') return Response.json(report([row('actions_linux', 100)]));
    if (repository === 'example-org/worker') return Response.json(report([row('actions_linux', 200)]));
    return Response.json(report([row('actions_linux', 5000), row('public_only_sku', 800)]));
  } };
  const result = await evaluateGitHubRunner({ ...config(), 'sku-minute-multipliers': { actions_linux: 1 } }, caller, token, now, transport);
  assert.equal(result.state, 'available');
  assert.equal(result.usage?.usedMinutes, 300);
  assert.equal(paths.filter(path => path.includes('/usage/summary')).length, 2);
  assert.ok(paths.every(path => !path.includes('repository=example-org%2Fpublic-docs')));
});

test('follows same-scope pages and evaluates the combined usage at the reserve threshold', async () => {
  const requested: string[] = [];
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async (input, init) => {
    const url = String(input);
    requested.push(url);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-billing-token');
    if (new URL(url).pathname.endsWith('/usage')) return Response.json({ usageItems: [{ product: 'Actions', unitType: 'Minutes', repositoryName: 'app' }] });
    if (new URL(url).pathname.startsWith('/repos/')) return Response.json({ full_name: 'example-org/app', private: true });
    assert.equal(new URL(url).searchParams.get('repository'), 'example-org/app');
    const second = url.includes('page=2');
    return new Response(JSON.stringify(report([row('actions_linux', second ? 50 : 2800)])), { headers: second ? {} : { link: `<${url}&page=2>; rel="next"` } });
  } };
  const result = await evaluateGitHubRunner(config(), caller, token, now, transport);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.usage?.usedMinutes, 2850);
  assert.equal(requested.length, 4);
});

test('rejects off-origin and wrong-scope pagination before disclosing a token', async () => {
  for (const next of ['https://attacker.invalid/usage', 'not-a-url', 'https://api.github.com/organizations/example-org/settings/billing/usage/summary?year=2026&month=8&product=Actions']) {
    let requests = 0;
    const transport: GitHubTransport = { sleep: async () => {}, fetch: async () => { requests++; return new Response(JSON.stringify(report([])), { headers: { link: `<${next}>; rel="next"` } }); } };
    await assert.rejects(evaluateGitHubRunner(config(), caller, token, now, transport), /pagination/);
    assert.equal(requests, 1);
  }
});
