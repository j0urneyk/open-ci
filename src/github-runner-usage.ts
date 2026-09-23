import { calculateBillingPeriod } from './billing-period.ts';
import { acquireBillingToken, type GitHubBillingCredentials } from './github-billing-auth.ts';
import { defaultGitHubTransport, requireGitHubObject } from './github-http.ts';
import { listPrivateBillingRepositories, readGitHubBillingPages } from './github-billing-repositories.ts';
import { evaluateUsageAllowance } from './runner-selection.ts';
import { ProviderQueryError, type CallerRepository, type GitHubProviderConfig, type ProviderEvaluation, type RunnerTarget } from './runner-contract.ts';

// Official standard runner labels, reviewed 2026-09-22. Unknown labels fail closed.
const STANDARD_RUNNER_LABELS = new Set([
  'ubuntu-slim', 'ubuntu-latest', 'ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-26.04',
  'ubuntu-22.04-arm', 'ubuntu-24.04-arm', 'ubuntu-26.04-arm',
  'windows-latest', 'windows-2022', 'windows-2025', 'windows-11-arm', 'windows-11-vs2026-arm',
  'macos-latest', 'macos-14', 'macos-15', 'macos-26', 'macos-15-intel', 'macos-26-intel', 'xcode-27',
]);

/** Classify only documented standard runner labels; groups and custom targets are not assumed free. */
export function isStandardGitHubRunner(target: RunnerTarget): boolean {
  const labels = typeof target === 'object' && !Array.isArray(target) ? (target.group === undefined ? target.labels : undefined) : target;
  const list = typeof labels === 'string' ? [labels] : labels;
  return list?.length === 1 && STANDARD_RUNNER_LABELS.has(list[0] ?? '');
}

/** Normalize private repository gross SKU quantities; every minute SKU needs an explicit verified factor. */
export function normalizeGitHubUsage(payload: unknown, owner: string, year: number, month: number, multipliers: Record<string, number>): number {
  const report = requireGitHubObject(payload);
  const period = requireGitHubObject(report.timePeriod);
  if (typeof report.organization !== 'string' || report.organization.toLowerCase() !== owner.toLowerCase() || period.year !== year || period.month !== month) throw new ProviderQueryError('GitHub usage invalid: organization or billing period mismatch.');
  if (!Array.isArray(report.usageItems)) throw new ProviderQueryError('GitHub usage invalid: missing usageItems.');
  let minutes = 0;
  for (const value of report.usageItems) {
    const item = requireGitHubObject(value);
    if (typeof item.product !== 'string' || typeof item.unitType !== 'string') throw new ProviderQueryError('GitHub usage invalid: missing product or unit.');
    if (item.product.toLowerCase() !== 'actions') throw new ProviderQueryError('GitHub usage invalid: unexpected product in Actions report.');
    if (item.unitType.toLowerCase() !== 'minutes') {
      if (typeof item.sku === 'string' && /storage|cache/.test(item.sku.toLowerCase())) continue;
      throw new ProviderQueryError('GitHub usage invalid: unrecognized compute unit.');
    }
    if (typeof item.sku !== 'string' || !Object.hasOwn(multipliers, item.sku)) throw new ProviderQueryError('GitHub usage unavailable: an observed minute SKU has no verified allowance multiplier.');
    if (typeof item.grossQuantity !== 'number' || !Number.isFinite(item.grossQuantity) || item.grossQuantity < 0) throw new ProviderQueryError('GitHub usage invalid: missing gross minute quantity.');
    // Count usage before discounts; explicit SKU factors convert it into allowance units.
    minutes += item.grossQuantity * multipliers[item.sku]!;
  }
  if (!Number.isFinite(minutes)) throw new ProviderQueryError('GitHub usage invalid: normalized minutes overflow.');
  return minutes;
}

/** Evaluate GitHub without a billing call for public standard runners or unverified paid targets. */
export async function evaluateGitHubRunner(config: GitHubProviderConfig, caller: CallerRepository, credentials: GitHubBillingCredentials, now = new Date(), transport = defaultGitHubTransport): Promise<ProviderEvaluation> {
  if (!isStandardGitHubRunner(config['runs-on'])) return { state: 'unavailable', reason: 'GitHub target is not a verified standard runner; free allowance eligibility is unknown.' };
  if (caller.visibility === 'public') return { state: 'available', reason: 'Standard GitHub-hosted runners are free for public repositories.' };
  const period = calculateBillingPeriod(config['billing-cycle'], now);
  const year = period.start.getUTCFullYear();
  const month = period.start.getUTCMonth() + 1;
  const lease = await acquireBillingToken(caller.owner, credentials, transport, now);
  let usedMinutes = 0;
  try {
    const repositories = await listPrivateBillingRepositories(caller.owner, year, month, lease.token, transport);
    for (const repository of repositories) {
      const firstPath = `/organizations/${encodeURIComponent(caller.owner)}/settings/billing/usage/summary?year=${year}&month=${month}&product=Actions&repository=${encodeURIComponent(repository)}`;
      for await (const payload of readGitHubBillingPages(firstPath, lease.token, transport)) usedMinutes += normalizeGitHubUsage(payload, caller.owner, year, month, config['sku-minute-multipliers']);
    }
  } finally { await lease.release(); }
  return evaluateUsageAllowance({ usedMinutes, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(), checkedAt: now.toISOString() }, config['free-minutes'], config['reserve-percent']);
}
