import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateBillingPeriod } from './billing-period.ts';

test('uses UTC calendar boundaries across year rollover and exact reset instants', () => {
  const anchor = { anchor: '2025-01-01T00:00:00Z' };
  for (const [now, expected] of [['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'], ['2025-12-31T23:59:59Z', '2025-12-01T00:00:00.000Z']]) assert.equal(calculateBillingPeriod(anchor, new Date(now!)).start.toISOString(), expected);
});

test('clamps monthly anchors to short months without drifting subsequent cycles', () => {
  const anchor = { anchor: '2024-01-31T12:00:00Z' };
  assert.equal(calculateBillingPeriod(anchor, new Date('2024-02-29T11:00:00Z')).start.toISOString(), '2024-01-31T12:00:00.000Z');
  assert.equal(calculateBillingPeriod(anchor, new Date('2024-02-29T12:00:00Z')).start.toISOString(), '2024-02-29T12:00:00.000Z');
  assert.equal(calculateBillingPeriod(anchor, new Date('2024-03-31T12:00:00Z')).start.toISOString(), '2024-03-31T12:00:00.000Z');
  assert.throws(() => calculateBillingPeriod(anchor, new Date('2024-01-01T00:00:00Z')));
});
