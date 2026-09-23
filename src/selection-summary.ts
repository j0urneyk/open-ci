import type { OpenCiConfig, SelectionAttempt } from './runner-contract.ts';

function escapeSummaryText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]/g, ' ');
}

/** Render selection diagnostics without raw payloads, credentials, or source-freshness claims. */
export function renderSelectionSummary(attempts: SelectionAttempt[], config: OpenCiConfig, configSource: string): string {
  const rows = attempts.map(({ provider, evaluation }) => {
    const details = 'usage' in evaluation && evaluation.usage ? ` Period ${evaluation.usage.periodStart} – ${evaluation.usage.periodEnd}; queried ${evaluation.usage.checkedAt}.` : '';
    const policy = config.providers[provider];
    const quota = policy && 'free-minutes' in policy ? ` Allowance ${policy['free-minutes']} minutes; reserve ${policy['reserve-percent']}%.` : '';
    return `| ${provider} | ${evaluation.state} | ${escapeSummaryText(evaluation.reason + quota + details)} |`;
  });
  return `## open-ci runner selection\n\nConfiguration: ${escapeSummaryText(configSource)}\n\nPriority: ${config.priority.join(' → ')}\n\n| Provider | Result | Reason |\n| --- | --- | --- |\n${rows.join('\n')}\n\nQuery time is not a guarantee that provider usage is fully aggregated.\n`;
}
