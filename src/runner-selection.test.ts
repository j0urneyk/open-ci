import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRunnerConfig } from './runner-config.ts';
import { evaluateUsageAllowance, selectRunnerProvider } from './runner-selection.ts';
import { NoRunnerAvailableError, OpenCiCancellationError, ProviderQueryError, type ProviderUsage } from './runner-contract.ts';

const policy = (priority: string[]) => resolveRunnerConfig({ priority, providers: {
  github: { 'runs-on': 'ubuntu-latest', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' }, 'sku-minute-multipliers': { actions_linux: 1 } },
  blacksmith: { 'runs-on': 'blacksmith-2vcpu-ubuntu-2404', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' } },
  'self-hosted': { 'runs-on': ['self-hosted', 'linux', 'x64'] },
} }, {});
const usage = (usedMinutes: number): ProviderUsage => ({ usedMinutes, periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-22T00:00:00Z', checkedAt: '2026-09-22T00:00:00Z' });

test('reserve boundary includes exactly 95 percent and zero allowance', () => {
  assert.equal(evaluateUsageAllowance(usage(2849.99), 3000, 5).state, 'available');
  assert.equal(evaluateUsageAllowance(usage(2850), 3000, 5).state, 'unavailable');
  assert.equal(evaluateUsageAllowance(usage(3001), 3000, 5).state, 'unavailable');
  assert.equal(evaluateUsageAllowance(usage(0), 0, 5).state, 'unavailable');
  assert.throws(() => evaluateUsageAllowance(usage(NaN), 3000, 5));
});

test('selects the first available provider without querying later providers', async () => {
  const queried: string[] = [];
  const result = await selectRunnerProvider(policy(['github', 'blacksmith', 'self-hosted']), async provider => {
    queried.push(provider);
    return evaluateUsageAllowance(usage(provider === 'github' ? 2850 : 100), 3000, 5);
  });
  assert.equal(result.provider, 'blacksmith');
  assert.deepEqual(queried, ['github', 'blacksmith']);
  assert.match(result.reason, /github:.*threshold/);
});

test('self-hosted first requires no provider lookups or credentials', async () => {
  const result = await selectRunnerProvider(policy(['self-hosted', 'github']), async () => { throw new Error('must not run'); });
  assert.equal(result.provider, 'self-hosted');
});

test('lookup failures skip candidates, but configuration/runtime bugs do not masquerade as usage failures', async () => {
  assert.equal((await selectRunnerProvider(policy(['github', 'self-hosted']), async () => { throw new ProviderQueryError('GitHub authentication unavailable: token missing.'); })).provider, 'self-hosted');
  await assert.rejects(selectRunnerProvider(policy(['github', 'self-hosted']), async () => { throw new Error('bug'); }), /bug/);
  await assert.rejects(selectRunnerProvider(policy(['blacksmith', 'self-hosted']), async () => { throw new OpenCiCancellationError('Open CI execution cancelled: test signal.'); }), OpenCiCancellationError);
  await assert.rejects(selectRunnerProvider(policy(['github']), async () => { throw new ProviderQueryError('GitHub request failed: HTTP 403.'); }), error => error instanceof NoRunnerAvailableError && error.attempts.length === 1);
});
