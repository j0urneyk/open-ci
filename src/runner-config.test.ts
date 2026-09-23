import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunnerConfig, resolveRunnerConfig, validateRunnerTarget } from './runner-config.ts';

const selfHosted = () => ({ version: 1, priority: ['self-hosted'], providers: { 'self-hosted': { 'runs-on': { group: 'ci', labels: ['linux', 'x64'] } } } });

test('repository overrides replace runner targets and priority without retaining group fields', () => {
  const base = { version: 1, priority: ['github', 'self-hosted'], providers: { github: { enabled: false }, 'self-hosted': { 'runs-on': { group: 'old', labels: 'old' } } } };
  const result = resolveRunnerConfig(base, { priority: ['self-hosted'], providers: { 'self-hosted': { 'runs-on': { labels: ['new'] } } } });
  assert.deepEqual(result.providers['self-hosted']?.['runs-on'], { labels: ['new'] });
  assert.deepEqual(result.priority, ['self-hosted']);
});

test('explicit priority is highest precedence and candidates are never appended', () => {
  assert.deepEqual(resolveRunnerConfig(selfHosted(), {}, '["self-hosted"]').priority, ['self-hosted']);
  for (const input of ['[]', '["self-hosted","self-hosted"]', '["unknown"]', '["github"]', 'null', 'broken']) assert.throws(() => resolveRunnerConfig(selfHosted(), {}, input));
});

test('validates string, array, labels and group runner targets as atomic values', () => {
  for (const target of ['ubuntu-latest', ['self-hosted', 'linux'], { group: 'ci' }, { labels: 'linux' }, { group: 'ci', labels: ['linux'] }]) assert.deepEqual(validateRunnerTarget(target), target);
  for (const target of [null, [], {}, { group: '' }, { labels: [] }, { label: 'linux' }, ['linux', 'linux'], 'label\ninjected']) assert.throws(() => validateRunnerTarget(target));
});

test('rejects aliases, duplicate keys, null, unknown fields and unsafe object keys', () => {
  for (const text of ['a: &a [one]\nb: *a', 'version: 1\nversion: 2', 'a: null', 'x: !secret token', '__proto__: { x: true }', 'a:\n  constructor: bad']) assert.throws(() => parseRunnerConfig(text, 'yaml'));
  assert.throws(() => parseRunnerConfig('{"version":1,"version":2}', 'json'));
  assert.throws(() => parseRunnerConfig('version: 1', 'json'));
  assert.throws(() => resolveRunnerConfig({ ...selfHosted(), typo: true }, {}));
  assert.throws(() => parseRunnerConfig('a'.repeat(49 * 1024), 'yaml'));
});

test('normalizes metered defaults and validates billing units and periods', () => {
  const config = () => ({ priority: ['github'], providers: { github: { 'runs-on': 'ubuntu-latest', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' }, 'sku-minute-multipliers': { actions_linux: 1 } } } });
  assert.equal(resolveRunnerConfig(config(), {}).providers.github?.['reserve-percent'], 5);
  assert.equal(resolveRunnerConfig(config(), { providers: { github: { 'free-minutes': 0, 'reserve-percent': 0 } } }).providers.github?.['reserve-percent'], 0);
  for (const value of [100, -1, Infinity, '5']) assert.throws(() => resolveRunnerConfig(config(), { providers: { github: { 'reserve-percent': value } } }));
  assert.throws(() => resolveRunnerConfig(config(), { providers: { github: { 'billing-cycle': { anchor: '2026-02-30T00:00:00Z' } } } }));
  assert.throws(() => resolveRunnerConfig(config(), { providers: { github: { 'billing-cycle': { anchor: '2026-01-02T00:00:00Z' } } } }));
  assert.throws(() => resolveRunnerConfig(config(), { providers: { github: { 'sku-minute-multipliers': { actions_linux: -1 } } } }));
  assert.throws(() => resolveRunnerConfig(selfHosted(), { providers: { 'self-hosted': { 'free-minutes': 100 } } }));
});
