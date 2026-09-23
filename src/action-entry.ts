import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveRunnerConfig, parseRunnerConfig } from './runner-config.ts';
import { loadCallerRepository, loadRepositoryConfig } from './caller-repository.ts';
import { evaluateGitHubRunner } from './github-runner-usage.ts';
import { evaluateBlacksmithRunner } from './blacksmith-runner-usage.ts';
import { selectRunnerProvider } from './runner-selection.ts';
import { renderSelectionSummary } from './selection-summary.ts';
import { NoRunnerAvailableError, OpenCiCancellationError, OpenCiConfigError, ProviderQueryError } from './runner-contract.ts';

function actionInput(name: string): string { return process.env[`INPUT_${name.toUpperCase()}`] ?? ''; }
function escapeWorkflowCommand(value: string): string { return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'); }

async function writeActionOutput(name: string, value: string): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error('Open CI runtime invalid: GITHUB_OUTPUT is unavailable.');
  const delimiter = `open_ci_${randomUUID()}`;
  await appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function executeRunnerSelection(): Promise<void> {
  const repositoryToken = actionInput('github-token');
  const caller = await loadCallerRepository(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_SHA ?? '', repositoryToken);
  const requestedPath = actionInput('config-path').trim();
  const configPath = requestedPath || '.github/open-ci.yml';
  const repositoryPolicy = await loadRepositoryConfig(caller, configPath, requestedPath !== '', repositoryToken);
  const config = resolveRunnerConfig(parseRunnerConfig(actionInput('config'), 'json'), parseRunnerConfig(repositoryPolicy, 'yaml'), actionInput('priority'));
  const source = `OPEN_CI_CONFIG + ${configPath}@${caller.sha}${repositoryPolicy ? '' : ' (file absent)'}`;
  const now = new Date();
  const evaluate = async (provider: 'github' | 'blacksmith') => {
    if (provider === 'github' && config.providers.github) return evaluateGitHubRunner(config.providers.github, caller, { token: actionInput('billing-token'), appId: actionInput('app-id'), privateKey: actionInput('app-private-key') }, now);
    if (provider === 'blacksmith' && config.providers.blacksmith) return evaluateBlacksmithRunner(config.providers.blacksmith, caller.owner, actionInput('blacksmith-token'), now);
    throw new Error('Open CI invariant failed: missing evaluated provider.');
  };
  try {
    const result = await selectRunnerProvider(config, evaluate);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, renderSelectionSummary(result.attempts, config, source));
    await writeActionOutput('provider', result.provider);
    await writeActionOutput('runs-on', JSON.stringify(result.runsOn));
    await writeActionOutput('reason', result.reason);
  } catch (error) {
    if (error instanceof NoRunnerAvailableError && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, renderSelectionSummary(error.attempts, config, source));
    throw error;
  }
}

executeRunnerSelection().catch((error: unknown) => {
  const message = error instanceof OpenCiConfigError || error instanceof ProviderQueryError || error instanceof NoRunnerAvailableError || error instanceof OpenCiCancellationError
    ? error.message : 'Open CI execution failed: unexpected runtime error. Check the runner prerequisites.';
  process.stdout.write(`::error::${escapeWorkflowCommand(message)}\n`);
  process.exitCode = 1;
});
