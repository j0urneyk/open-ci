/** Runner provider names are stable workflow input/output identifiers. */
export type RunnerProvider = 'github' | 'blacksmith' | 'self-hosted';
/** A runner target preserves GitHub runs-on labels and group semantics. */
export type RunnerTarget = string | string[] | { group?: string; labels?: string | string[] };
/** Billing periods require an explicit monthly UTC anchor, not a rolling window. */
export interface BillingCycle { anchor: string }
interface RunnerProviderBase { enabled: boolean; 'runs-on': RunnerTarget }
interface MeteredRunnerBase extends RunnerProviderBase {
  'free-minutes': number;
  'reserve-percent': number;
  'billing-cycle': BillingCycle;
}
/** GitHub SKU multipliers convert gross minutes into the configured allowance unit. */
export interface GitHubProviderConfig extends MeteredRunnerBase {
  'sku-minute-multipliers': Record<string, number>;
}
/** Blacksmith allowance minutes are x64 Linux 2-vCPU equivalent minutes. */
export interface BlacksmithProviderConfig extends MeteredRunnerBase {}
/** Self-hosted runner configuration carries no usage or availability policy. */
export interface SelfHostedProviderConfig extends RunnerProviderBase {}
/** Validated open-ci configuration belongs to the calling organization. */
export interface OpenCiConfig {
  version: 1;
  priority: RunnerProvider[];
  providers: {
    github?: GitHubProviderConfig;
    blacksmith?: BlacksmithProviderConfig;
    'self-hosted'?: SelfHostedProviderConfig;
  };
}
/** Caller context is derived from GitHub's API, never from repository policy. */
export interface CallerRepository { owner: string; name: string; visibility: 'public' | 'private'; sha: string }
/** Usage observations record request time separately from any source aggregation time. */
export interface ProviderUsage { usedMinutes: number; periodStart: string; periodEnd: string; checkedAt: string }
/** Candidate evaluations distinguish skipped providers from eligible selections. */
export type ProviderEvaluation =
  | { state: 'available'; reason: string; usage?: ProviderUsage }
  | { state: 'unavailable'; reason: string; usage?: ProviderUsage };
/** Selection attempts retain provider order for workflow diagnostics. */
export interface SelectionAttempt { provider: RunnerProvider; evaluation: ProviderEvaluation }
/** Runner selection outputs contain only one target and explain prior exclusions. */
export interface RunnerSelection { provider: RunnerProvider; runsOn: RunnerTarget; reason: string; attempts: SelectionAttempt[] }
/** Configuration errors terminate selection rather than silently selecting a fallback. */
export class OpenCiConfigError extends Error { override name = 'OpenCiConfigError'; }
/** Provider failures are safe to display and permit the next configured candidate. */
export class ProviderQueryError extends Error { override name = 'ProviderQueryError'; }
/** Action cancellation aborts selection instead of falling back to another provider. */
export class OpenCiCancellationError extends Error { override name = 'OpenCiCancellationError'; }
/** Exhausted candidates fail the selector while preserving diagnostic attempts. */
export class NoRunnerAvailableError extends Error {
  override name = 'NoRunnerAvailableError';
  readonly attempts: SelectionAttempt[];
  constructor(attempts: SelectionAttempt[]) {
    super('Open CI selection failed: no configured provider is available.');
    this.attempts = attempts;
  }
}
