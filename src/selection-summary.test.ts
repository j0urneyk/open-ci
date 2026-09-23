import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRunnerConfig } from './runner-config.ts';
import { renderSelectionSummary } from './selection-summary.ts';
import { evaluateUsageAllowance } from './runner-selection.ts';

test('retains exhausted-provider usage windows and escapes summary markup', () => {
  const config = resolveRunnerConfig({ priority: ['blacksmith'], providers: { blacksmith: { 'runs-on': 'blacksmith-2vcpu-ubuntu-2404', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' } } } }, {});
  const usage = { usedMinutes: 2850, periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-22T00:00:00Z', checkedAt: '2026-09-22T00:00:00Z' };
  const text = renderSelectionSummary([{ provider: 'blacksmith', evaluation: evaluateUsageAllowance(usage, 3000, 5) }], config, '<script>|\nsource');
  assert.match(text, /Allowance 3000 minutes; reserve 5%/);
  assert.match(text, /Period 2026-09-01/);
  assert.match(text, /queried 2026-09-22/);
  assert.ok(!text.includes('<script>'));
  assert.match(text, /Query time is not a guarantee/);
});
