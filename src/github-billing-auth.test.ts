import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { test } from 'node:test';
import { acquireBillingToken } from './github-billing-auth.ts';
import type { GitHubTransport } from './github-http.ts';

test('uses an explicit billing token without minting or revoking it', async () => {
  const transport: GitHubTransport = { fetch: async () => assert.fail('no API call expected'), sleep: async () => {} };
  const lease = await acquireBillingToken('org', { token: 'provided', appId: '', privateKey: '' }, transport);
  assert.equal(lease.token, 'provided');
  await lease.release();
});

test('signs a short-lived App JWT, resolves organization installation, and revokes the minted token', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const urls: string[] = [];
  const transport: GitHubTransport = { sleep: async () => {}, fetch: async (url, init) => {
    urls.push(String(url));
    const auth = new Headers(init?.headers).get('Authorization')!.slice(7);
    if (String(url).endsWith('/installation/token')) { assert.equal(init?.method, 'DELETE'); assert.equal(auth, 'minted-token'); return new Response(null, { status: 204 }); }
    const [header, body, signature] = auth.split('.');
    assert.ok(header && body && signature);
    assert.equal(createVerify('RSA-SHA256').update(`${header}.${body}`).verify(publicKey, signature, 'base64url'), true);
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    assert.equal(payload.iss, '123');
    assert.equal(payload.exp - payload.iat, 600);
    if (String(url).endsWith('/installation')) return Response.json({ id: 456 });
    assert.equal(init?.method, 'POST');
    return Response.json({ token: 'minted-token' });
  } };
  const lease = await acquireBillingToken('org', { token: '', appId: '123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, transport, new Date('2026-09-22T00:00:00Z'));
  await lease.release();
  assert.deepEqual(urls, ['https://api.github.com/orgs/org/installation', 'https://api.github.com/app/installations/456/access_tokens', 'https://api.github.com/installation/token']);
});

test('missing or malformed App credentials produce safe provider failures', async () => {
  await assert.rejects(acquireBillingToken('org', { token: '', appId: '', privateKey: '' }), /authentication unavailable/);
  await assert.rejects(acquireBillingToken('org', { token: '', appId: '123', privateKey: 'synthetic-private-secret' }), error => error instanceof Error && !error.message.includes('synthetic-private-secret'));
});
