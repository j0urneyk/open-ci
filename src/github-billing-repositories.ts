import { defaultGitHubTransport, requestGitHubJson, requireGitHubObject } from './github-http.ts';
import { ProviderQueryError } from './runner-contract.ts';

/** Billing pagination must preserve the organization, period, product and repository scope. */
export async function* readGitHubBillingPages(firstPath: string, token: string, transport = defaultGitHubTransport): AsyncGenerator<unknown> {
  const firstUrl = new URL(firstPath, 'https://api.github.com');
  const seen = new Set<string>();
  let path: string | undefined = firstPath;
  while (path) {
    if (seen.has(path) || seen.size >= 100) throw new ProviderQueryError('GitHub usage invalid: pagination did not terminate.');
    seen.add(path);
    const response = await requestGitHubJson(path, token, {}, transport);
    const next: string | undefined = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    path = undefined;
    if (next) {
      let nextUrl: URL;
      try { nextUrl = new URL(next); } catch { throw new ProviderQueryError('GitHub usage invalid: malformed pagination URL.'); }
      if (nextUrl.origin !== firstUrl.origin || nextUrl.pathname !== firstUrl.pathname || ['year', 'month', 'product', 'repository', 'sku', 'day'].some(key => nextUrl.searchParams.get(key) !== firstUrl.searchParams.get(key))) throw new ProviderQueryError('GitHub usage invalid: pagination scope changed.');
      path = nextUrl.pathname + nextUrl.search;
    }
    yield response.data;
  }
}

/** Discover all billed private repositories; public runner usage does not consume included minutes. */
export async function listPrivateBillingRepositories(owner: string, year: number, month: number, token: string, transport = defaultGitHubTransport): Promise<string[]> {
  const repositories = new Map<string, string>();
  const firstPath = `/organizations/${encodeURIComponent(owner)}/settings/billing/usage?year=${year}&month=${month}`;
  for await (const payload of readGitHubBillingPages(firstPath, token, transport)) {
    const report = requireGitHubObject(payload);
    if (!Array.isArray(report.usageItems)) throw new ProviderQueryError('GitHub usage invalid: missing repository usage items.');
    for (const value of report.usageItems) {
      const item = requireGitHubObject(value);
      if (typeof item.product !== 'string') throw new ProviderQueryError('GitHub usage invalid: missing billed product.');
      if (item.product.toLowerCase() !== 'actions') continue;
      if (typeof item.unitType !== 'string') throw new ProviderQueryError('GitHub usage invalid: missing compute unit.');
      if (item.unitType.toLowerCase() !== 'minutes') {
        if (typeof item.sku === 'string' && /storage|cache/.test(item.sku.toLowerCase())) continue;
        throw new ProviderQueryError('GitHub usage invalid: unrecognized compute unit.');
      }
      if (item.organizationName !== undefined && (typeof item.organizationName !== 'string' || item.organizationName.toLowerCase() !== owner.toLowerCase())) throw new ProviderQueryError('GitHub usage invalid: billed repository organization mismatch.');
      if (typeof item.repositoryName !== 'string') throw new ProviderQueryError('GitHub usage invalid: compute usage has no repository identity.');
      const parts = item.repositoryName.split('/');
      const name = parts.at(-1)!;
      if (parts.length > 2 || (parts.length === 2 && parts[0]!.toLowerCase() !== owner.toLowerCase()) || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new ProviderQueryError('GitHub usage invalid: billed repository identity is malformed.');
      repositories.set(name.toLowerCase(), name);
    }
  }
  const privateRepositories: string[] = [];
  for (const name of repositories.values()) {
    let metadata: Record<string, unknown>;
    try {
      metadata = requireGitHubObject((await requestGitHubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token, {}, transport)).data);
    } catch (error) {
      if (!(error instanceof ProviderQueryError)) throw error;
      throw new ProviderQueryError('GitHub usage unavailable: cannot verify a billed repository; the billing credential needs repository Metadata read access.');
    }
    if (typeof metadata.private !== 'boolean' || typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()) throw new ProviderQueryError('GitHub usage invalid: billed repository metadata identity or visibility mismatch.');
    if (metadata.private) privateRepositories.push(`${owner}/${name}`);
  }
  return privateRepositories;
}
