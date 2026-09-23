import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPrivateBillingRepositories, readGitHubBillingPages } from './github-billing-repositories.ts';
import type { GitHubTransport } from './github-http.ts';

const usageRow = (repositoryName: unknown) => ({ product: 'Actions', unitType: 'Minutes', sku: 'Actions Linux', repositoryName, organizationName: 'example-org' });

test('discovers repositories across usage pages and deduplicates canonical identities', async () => {
  const calls: string[] = [];
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async input => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.startsWith('/repos/')) return Response.json({ full_name: 'example-org/APP', private: true });
    return Response.json({ usageItems: [usageRow(url.searchParams.has('page') ? 'example-org/APP' : 'app')] }, { headers: url.searchParams.has('page') ? {} : { link: `<${url.href}&page=2>; rel="next"` } });
  } };
  assert.deepEqual(await listPrivateBillingRepositories('example-org', 2026, 9, 'synthetic-token', transport), ['example-org/APP']);
  assert.equal(calls.length, 3);
});

test('refuses usage with missing, malformed or foreign repository identity', async () => {
  for (const item of [usageRow(undefined), usageRow('../app'), usageRow('foreign-org/app'), { ...usageRow('app'), organizationName: 'foreign-org' }]) {
    let requests = 0;
    const transport: GitHubTransport = { sleep: async () => {}, fetch: async () => { requests++; return Response.json({ usageItems: [item] }); } };
    await assert.rejects(listPrivateBillingRepositories('example-org', 2026, 9, 'synthetic-token', transport), /repository|organization/);
    assert.equal(requests, 1);
  }
});

test('cannot silently exclude repositories whose metadata is unavailable or mismatched', async () => {
  for (const response of [() => Response.json({}, { status: 404 }), () => Response.json({ full_name: 'example-org/other', private: false }), () => Response.json({ full_name: 'example-org/app' })]) {
    const transport: GitHubTransport = { sleep: async () => {}, fetch: async input => String(input).includes('/repos/') ? response() : Response.json({ usageItems: [usageRow('app')] }) };
    await assert.rejects(listPrivateBillingRepositories('example-org', 2026, 9, 'synthetic-token', transport), /Metadata|metadata/);
  }
});

test('ignores non-compute products and requires a complete usage-items array', async () => {
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async () => Response.json({ usageItems: [{ product: 'Copilot' }, { product: 'Actions', sku: 'Actions storage', unitType: 'GigabyteHours' }] }) };
  assert.deepEqual(await listPrivateBillingRepositories('example-org', 2026, 9, 'synthetic-token', transport), []);
  await assert.rejects(listPrivateBillingRepositories('example-org', 2026, 9, 'synthetic-token', { ...transport, fetch: async () => Response.json({}) }), /missing repository usage/);
});

test('summary pagination cannot change the repository filter or repeat a page', async () => {
  const first = '/organizations/example-org/settings/billing/usage/summary?year=2026&month=9&product=Actions&repository=example-org%2Fapp';
  for (const next of [`https://api.github.com${first.replace('example-org%2Fapp', 'example-org%2Fother')}`, `https://api.github.com${first}`]) {
    const transport: GitHubTransport = { sleep: async () => {}, fetch: async () => Response.json({ usageItems: [] }, { headers: { link: `<${next}>; rel="next"` } }) };
    await assert.rejects(async () => { for await (const _page of readGitHubBillingPages(first, 'synthetic-token', transport)) {} }, /pagination/);
  }
});
