import { OpenCiConfigError, ProviderQueryError, type CallerRepository } from './runner-contract.ts';
import { defaultGitHubTransport, requestGitHubJson, requireGitHubObject } from './github-http.ts';

/** Resolve caller identity via GitHub rather than accepting an organization override from config. */
export async function loadCallerRepository(repository: string, sha: string, token: string, transport = defaultGitHubTransport): Promise<CallerRepository> {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match || !/^[a-f0-9]{40}$/i.test(sha)) throw new OpenCiConfigError('Open CI caller invalid: GITHUB_REPOSITORY and GITHUB_SHA must identify a repository commit.');
  const owner = match[1]!;
  const name = match[2]!;
  const response = requireGitHubObject((await requestGitHubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token, {}, transport)).data);
  const account = requireGitHubObject(response.owner);
  if (account.type !== 'Organization') throw new OpenCiConfigError('Open CI caller unsupported: only organization-owned repositories are supported.');
  if (typeof account.login !== 'string' || account.login.toLowerCase() !== owner.toLowerCase() || typeof response.private !== 'boolean') throw new ProviderQueryError('GitHub repository response invalid: owner or visibility mismatch.');
  return { owner: account.login, name, visibility: response.private ? 'private' : 'public', sha };
}

/** Read repository policy at the run commit; an explicitly requested missing file is an error. */
export async function loadRepositoryConfig(caller: CallerRepository, configPath: string, explicitPath: boolean, token: string, transport = defaultGitHubTransport): Promise<string> {
  const segments = configPath.split('/');
  if (!configPath || configPath.startsWith('/') || configPath.includes('\\') || segments.some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(configPath)) throw new OpenCiConfigError('Open CI config path invalid: use a relative repository file path without traversal.');
  const path = `/repos/${encodeURIComponent(caller.owner)}/${encodeURIComponent(caller.name)}/contents/${segments.map(encodeURIComponent).join('/')}?ref=${caller.sha}`;
  const response = await requestGitHubJson(path, token, { allowNotFound: true }, transport);
  if (response.status === 404) {
    if (explicitPath) throw new OpenCiConfigError('Open CI config file missing: the explicitly requested path does not exist at the run commit.');
    return '';
  }
  const file = requireGitHubObject(response.data);
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') throw new OpenCiConfigError('Open CI config file invalid: expected a regular base64-encoded repository file.');
  if (typeof file.size !== 'number' || file.size > 48 * 1024 || file.content.length > 70 * 1024) throw new OpenCiConfigError('Open CI config file invalid: policy exceeds 48 KiB.');
  const encoded = file.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new OpenCiConfigError('Open CI config file invalid: malformed base64 content.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64')); }
  catch { throw new OpenCiConfigError('Open CI config file invalid: policy is not UTF-8 text.'); }
}
