import { NoRunnerAvailableError, ProviderQueryError, type OpenCiConfig, type ProviderEvaluation, type ProviderUsage, type RunnerProvider, type RunnerSelection, type SelectionAttempt } from './runner-contract.ts';

/** Compare normalized allowance minutes at the exact reserve boundary. */
export function evaluateUsageAllowance(usage: ProviderUsage, freeMinutes: number, reservePercent: number): ProviderEvaluation {
  if (!Number.isFinite(usage.usedMinutes) || usage.usedMinutes < 0) throw new ProviderQueryError('Provider usage invalid: used minutes must be finite and nonnegative.');
  const limit = freeMinutes * (1 - reservePercent / 100);
  return usage.usedMinutes < limit
    ? { state: 'available', reason: `Usage ${usage.usedMinutes} is below the ${limit} minute selection threshold.`, usage }
    : { state: 'unavailable', reason: `Usage ${usage.usedMinutes} has reached the ${limit} minute selection threshold.`, usage };
}

/** Select the first eligible provider lazily; infrastructure lookup failures never mean zero usage. */
export async function selectRunnerProvider(config: OpenCiConfig, evaluate: (provider: Exclude<RunnerProvider, 'self-hosted'>) => Promise<ProviderEvaluation>): Promise<RunnerSelection> {
  const attempts: SelectionAttempt[] = [];
  for (const provider of config.priority) {
    let evaluation: ProviderEvaluation;
    if (provider === 'self-hosted') evaluation = { state: 'available', reason: 'Self-hosted has no usage quota; availability is not probed.' };
    else {
      try { evaluation = await evaluate(provider); }
      catch (error) {
        if (!(error instanceof ProviderQueryError)) throw error;
        evaluation = { state: 'unavailable', reason: error.message };
      }
    }
    attempts.push({ provider, evaluation });
    if (evaluation.state === 'available') {
      const selected = config.providers[provider];
      if (!selected) throw new Error('Open CI invariant failed: selected provider has no configuration.');
      return { provider, runsOn: selected['runs-on'], reason: attempts.map(attempt => `${attempt.provider}: ${attempt.evaluation.reason}`).join(' '), attempts };
    }
  }
  throw new NoRunnerAvailableError(attempts);
}
