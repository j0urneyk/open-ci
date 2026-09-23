import { createSign } from 'node:crypto';
import { ProviderQueryError } from './runner-contract.ts';
import { defaultGitHubTransport, requestGitHubJson, requireGitHubObject } from './github-http.ts';

/** Billing credentials are explicit action secrets, separate from the repository contents token. */
export interface GitHubBillingCredentials { token: string; appId: string; privateKey: string }

/** Mint an organization installation token only when a metered GitHub candidate is evaluated. */
export async function acquireBillingToken(owner: string, credentials: GitHubBillingCredentials, transport = defaultGitHubTransport, now = new Date()): Promise<{ token: string; release: () => Promise<void> }> {
  // A supplied token takes precedence and remains caller-owned, so release must not revoke it.
  if (credentials.token) return { token: credentials.token, release: async () => {} };
  if (!credentials.appId || !credentials.privateKey) throw new ProviderQueryError('GitHub billing authentication unavailable: provide a billing token or App ID and private key.');
  let jwt: string;
  try {
    const seconds = Math.floor(now.getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: credentials.appId })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey, 'base64url')}`;
  } catch { throw new ProviderQueryError('GitHub billing authentication invalid: unable to sign the App JWT.'); }
  const installation = requireGitHubObject((await requestGitHubJson(`/orgs/${encodeURIComponent(owner)}/installation`, jwt, {}, transport)).data);
  if (!Number.isSafeInteger(installation.id) || Number(installation.id) <= 0) throw new ProviderQueryError('GitHub installation response invalid: missing installation ID.');
  const result = requireGitHubObject((await requestGitHubJson(`/app/installations/${installation.id}/access_tokens`, jwt, { method: 'POST', body: {} }, transport)).data);
  if (typeof result.token !== 'string' || !result.token) throw new ProviderQueryError('GitHub installation response invalid: missing token.');
  const token = result.token;
  return { token, release: async () => { await requestGitHubJson('/installation/token', token, { method: 'DELETE' }, transport); } };
}
