import { setTimeout as delay } from 'node:timers/promises';
import { ProviderQueryError } from './runner-contract.ts';

/** GitHub transport permits injection in tests while production uses the public REST origin. */
export interface GitHubTransport { fetch: typeof fetch; sleep: (milliseconds: number) => Promise<void> }
/** Default GitHub transport has bounded retries and no persistent response cache. */
export const defaultGitHubTransport: GitHubTransport = { fetch: globalThis.fetch, sleep: delay };

/** Read GitHub JSON with a per-attempt timeout; never include response bodies or tokens in errors. */
export async function requestGitHubJson(path: string, token: string, options: { method?: string; body?: object; allowNotFound?: boolean } = {}, transport = defaultGitHubTransport): Promise<{ data: unknown; headers: Headers; status: number }> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new ProviderQueryError('GitHub request invalid: API path must be relative.');
  if (!token) throw new ProviderQueryError('GitHub authentication unavailable: a token is required.');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await transport.fetch(`https://api.github.com${path}`, {
        method: options.method ?? 'GET',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'open-ci', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (response.status === 404 && options.allowNotFound) return { data: null, headers: response.headers, status: 404 };
      const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      if (retryable && attempt < 2) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        await transport.sleep(Math.min(5000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0)));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderQueryError(`GitHub request failed: HTTP ${response.status}.`);
      }
      if (response.status === 204) return { data: null, headers: response.headers, status: response.status };
      const text = await response.text();
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ProviderQueryError('GitHub response invalid: payload exceeds 8 MiB.');
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new ProviderQueryError('GitHub response invalid: expected JSON.'); }
      return { data, headers: response.headers, status: response.status };
    } catch (error) {
      if (error instanceof ProviderQueryError) throw error;
      if (attempt === 2) throw new ProviderQueryError('GitHub request unavailable: network failure or timeout.');
      await transport.sleep(500 * 2 ** attempt);
    }
  }
  throw new ProviderQueryError('GitHub request unavailable: retries exhausted.');
}

/** Validate API objects at trust boundaries before accessing documented fields. */
export function requireGitHubObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderQueryError('GitHub response invalid: expected an object.');
  return value as Record<string, unknown>;
}
