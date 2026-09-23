import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCallerRepository, loadRepositoryConfig } from './caller-repository.ts';
import type { GitHubTransport } from './github-http.ts';
import type { CallerRepository } from './runner-contract.ts';

const caller: CallerRepository = { owner: 'org', name: 'repo', sha: 'a'.repeat(40), visibility: 'private' };
const reply = (data: unknown, status = 200): GitHubTransport => ({ sleep: async () => {}, fetch: async () => Response.json(data, { status }) });

test('caller scope comes from repository metadata and rejects personal owners', async () => {
  assert.equal((await loadCallerRepository('org/repo', caller.sha, 'token', reply({ owner: { login: 'org', type: 'Organization' }, private: false }))).visibility, 'public');
  await assert.rejects(loadCallerRepository('org/repo', caller.sha, 'token', reply({ owner: { login: 'org', type: 'User' }, private: false })), /organization-owned/);
  await assert.rejects(loadCallerRepository('org/repo', caller.sha, 'token', reply({ owner: { login: 'other', type: 'Organization' }, private: false })), /mismatch/);
});

test('reads the selected file at the exact run commit without checking out caller code', async () => {
  const text = 'priority: [self-hosted]\n';
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async url => {
    assert.equal(String(url), `https://api.github.com/repos/org/repo/contents/.github/open-ci.yml?ref=${caller.sha}`);
    return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length });
  } };
  assert.equal(await loadRepositoryConfig(caller, '.github/open-ci.yml', false, 'token', transport), text);
});

test('distinguishes an optional absent file from a missing explicit path', async () => {
  assert.equal(await loadRepositoryConfig(caller, '.github/open-ci.yml', false, 'token', reply({}, 404)), '');
  await assert.rejects(loadRepositoryConfig(caller, 'custom.yml', true, 'token', reply({}, 404)), /explicitly requested/);
});

test('rejects traversal, directories, corrupt base64 and invalid text', async () => {
  for (const path of ['../config', '/absolute', '.github/../config', '.github//config', 'x\\config']) await assert.rejects(loadRepositoryConfig(caller, path, true, 'token', reply({})), /path invalid/);
  for (const file of [{ type: 'dir' }, { type: 'file', encoding: 'base64', content: '?garbage', size: 7 }, { type: 'file', encoding: 'base64', content: '/w==', size: 1 }]) await assert.rejects(loadRepositoryConfig(caller, 'config.yml', true, 'token', reply(file)), /invalid/);
});
