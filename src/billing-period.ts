import { ProviderQueryError, type BillingCycle } from './runner-contract.ts';

/** Compute a monthly billing window from an operator-declared UTC anchor, clamping month-end anniversaries. */
export function calculateBillingPeriod(cycle: BillingCycle, now: Date): { start: Date; end: Date } {
  // This configured schedule is not evidence of the provider's actual free-tier reset time.
  const anchor = new Date(cycle.anchor);
  if (!Number.isFinite(now.getTime()) || now < anchor) throw new ProviderQueryError('Billing period unavailable: the current time precedes its configured anchor.');
  const boundary = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
  };
  let start = boundary(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = boundary(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { start, end: now };
}
