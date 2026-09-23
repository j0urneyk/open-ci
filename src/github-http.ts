import { setTimeout as delay } from 'node:timers/promises';
import { ProviderQueryError } from './runner-contract.ts';

/** GitHub transport permits injection in tests while production uses the public REST origin. */
export interface GitHubTransport { fetch: typeof fetch; sleep: (milliseconds: number) => Promise<void>; now?: () => number }
/** Default GitHub transport has bounded retries and no persistent response cache. */
export const defaultGitHubTransport: GitHubTransport = { fetch: globalThis.fetch, sleep: delay };

const MAX_GITHUB_RETRY_WAIT_MS = 5000;
const githubCredentialCooldowns = new WeakMap<GitHubTransport, Map<string, number>>();

function githubRetryDeadline(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  // A headerless 403 can be secondary throttling; conservatively protect follow-up calls too.
  const rateLimited = response.status === 429 || response.status === 403;
  if (!rateLimited && retryAfter === null) return undefined;
  let deadline = now;
  if (retryAfter !== null) {
    const value = retryAfter.trim();
    if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) deadline = now + Number(value) * 1000;
    else {
      const date = Date.parse(value);
      if (!Number.isFinite(date) || new Date(date).toUTCString() !== value) return Infinity;
      deadline = Math.max(now, date);
    }
  }
  if (exhausted) {
    const reset = response.headers.get('x-ratelimit-reset') ?? '';
    if (!/^\d+$/.test(reset) || !Number.isSafeInteger(Number(reset))) return Infinity;
    deadline = Math.max(deadline, Number(reset) * 1000);
  } else if (rateLimited && retryAfter === null) deadline = now + 60_000;
  return deadline;
}

async function waitForGitHubRetry(token: string, transport: GitHubTransport, cooldowns: Map<string, number>, backoff: number): Promise<void> {
  const deadline = cooldowns.get(token);
  const wait = Math.max(backoff, (deadline ?? 0) - (transport.now?.() ?? Date.now()));
  if (wait > MAX_GITHUB_RETRY_WAIT_MS) throw new ProviderQueryError('GitHub request unavailable: server cooldown cannot be honored within the 5-second retry budget.');
  if (wait > 0) await transport.sleep(wait);
  if (cooldowns.get(token) === deadline) cooldowns.delete(token);
}

/** Read GitHub JSON with a per-attempt timeout; never include response bodies or tokens in errors. */
export async function requestGitHubJson(path: string, token: string, options: { method?: string; body?: object; allowNotFound?: boolean } = {}, transport = defaultGitHubTransport): Promise<{ data: unknown; headers: Headers; status: number }> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new ProviderQueryError('GitHub request invalid: API path must be relative.');
  if (!token) throw new ProviderQueryError('GitHub authentication unavailable: a token is required.');
  let cooldowns = githubCredentialCooldowns.get(transport);
  if (!cooldowns) { cooldowns = new Map(); githubCredentialCooldowns.set(transport, cooldowns); }
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForGitHubRetry(token, transport, cooldowns, attempt === 0 ? 0 : 500 * 2 ** (attempt - 1));
    try {
      const response = await transport.fetch(`https://api.github.com${path}`, {
        method: options.method ?? 'GET',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'open-ci', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (response.status === 404 && options.allowNotFound) return { data: null, headers: response.headers, status: 404 };
      const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
      const deadline = githubRetryDeadline(response, transport.now?.() ?? Date.now());
      // Token revocation and other follow-up calls must honor the same cooldown.
      if (deadline !== undefined) cooldowns.set(token, Math.max(cooldowns.get(token) ?? 0, deadline));
      if (retryable && attempt < 2) {
        await response.body?.cancel();
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
    }
  }
  throw new ProviderQueryError('GitHub request unavailable: retries exhausted.');
}

/** Validate API objects at trust boundaries before accessing documented fields. */
export function requireGitHubObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderQueryError('GitHub response invalid: expected an object.');
  return value as Record<string, unknown>;
}
