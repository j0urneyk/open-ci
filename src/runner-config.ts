import { parseDocument } from 'yaml';
import { OpenCiConfigError, type OpenCiConfig, type RunnerProvider, type RunnerTarget } from './runner-contract.ts';

const PROVIDER_NAMES = ['github', 'blacksmith', 'self-hosted'] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_CONFIG_BYTES = 48 * 1024;

function invalidConfig(path: string, requirement: string): never {
  throw new OpenCiConfigError(`Open CI configuration invalid: ${path} ${requirement}.`);
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertConfigKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalidConfig(path, 'contains an unsupported field');
}

function assertSafeConfigTree(value: unknown, depth = 0): void {
  if (depth > 15) invalidConfig('document', 'is too deeply nested');
  if (Array.isArray(value)) value.forEach(item => assertSafeConfigTree(item, depth + 1));
  else if (isConfigObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) invalidConfig('document', 'contains an unsafe key');
      assertSafeConfigTree(child, depth + 1);
    }
  } else if (value === null) invalidConfig('document', 'does not accept null values');
}

/** Parse organization JSON or repository YAML without executing tags or merge directives. */
export function parseRunnerConfig(text: string, format: 'json' | 'yaml'): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) invalidConfig('document', 'exceeds 48 KiB');
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    if (format === 'json') JSON.parse(text);
    const document = parseDocument(text, { schema: 'core', uniqueKeys: true, merge: false });
    if (document.errors.length || document.warnings.length) invalidConfig('document', 'has invalid syntax or unsupported tags');
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    invalidConfig('document', `must be valid ${format.toUpperCase()} without duplicate keys or aliases`);
  }
  if (!isConfigObject(value)) invalidConfig('document', 'must be an object');
  assertSafeConfigTree(value);
  return value;
}

function mergeRunnerObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    // Replace runs-on atomically: retaining an inherited group would change runner routing.
    merged[key] = key !== 'runs-on' && isConfigObject(previous) && isConfigObject(value)
      ? mergeRunnerObjects(previous, value) : value;
  }
  return merged;
}

function assertRunnerLabel(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    invalidConfig(path, 'must be a nonempty single-line string');
  }
}

function assertRunnerLabels(value: unknown, path: string): asserts value is string | string[] {
  if (Array.isArray(value)) {
    if (!value.length) invalidConfig(path, 'must not be empty');
    value.forEach(item => assertRunnerLabel(item, path));
    if (new Set(value).size !== value.length) invalidConfig(path, 'must not contain duplicates');
  } else assertRunnerLabel(value, path);
}

/** Validate runs-on as an atomic target; groups and labels are never merged across targets. */
export function validateRunnerTarget(value: unknown): RunnerTarget {
  if (isConfigObject(value)) {
    assertConfigKeys(value, ['group', 'labels'], 'runs-on');
    if (value.group === undefined && value.labels === undefined) invalidConfig('runs-on', 'requires group or labels');
    if (value.group !== undefined) assertRunnerLabel(value.group, 'runs-on.group');
    if (value.labels !== undefined) assertRunnerLabels(value.labels, 'runs-on.labels');
  } else assertRunnerLabels(value, 'runs-on');
  return value as RunnerTarget;
}

function validateProviderPriority(value: unknown): RunnerProvider[] {
  if (!Array.isArray(value) || value.length === 0) invalidConfig('priority', 'requires a nonempty array');
  for (const entry of value) {
    if (!(PROVIDER_NAMES as readonly unknown[]).includes(entry)) invalidConfig('priority', 'contains an unknown provider');
  }
  if (new Set(value).size !== value.length) invalidConfig('priority', 'must not contain duplicates');
  return value as RunnerProvider[];
}

function assertFiniteNumber(value: unknown, path: string, allowZero: boolean): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) invalidConfig(path, 'must be a finite nonnegative number');
}

/** Resolve configuration precedence and validate every configured provider before querying usage. */
export function resolveRunnerConfig(base: Record<string, unknown>, override: Record<string, unknown>, priorityInput = ''): OpenCiConfig {
  assertSafeConfigTree(base);
  assertSafeConfigTree(override);
  const value = mergeRunnerObjects({ version: 1, ...structuredClone(base) }, structuredClone(override));
  assertConfigKeys(value, ['version', 'priority', 'providers'], 'document');
  if (value.version !== 1) invalidConfig('version', 'must equal 1');
  if (priorityInput.trim()) {
    try { value.priority = JSON.parse(priorityInput); } catch { invalidConfig('priority input', 'must be a JSON array'); }
  }
  const priority = validateProviderPriority(value.priority);
  if (!isConfigObject(value.providers)) invalidConfig('providers', 'must be an object');
  assertConfigKeys(value.providers, PROVIDER_NAMES, 'providers');
  for (const [name, raw] of Object.entries(value.providers)) {
    if (!isConfigObject(raw)) invalidConfig(`providers.${name}`, 'must be an object');
    const keys = ['enabled', 'runs-on'];
    if (name !== 'self-hosted') keys.push('free-minutes', 'reserve-percent', 'billing-cycle');
    if (name === 'github') keys.push('sku-minute-multipliers');
    assertConfigKeys(raw, keys, `providers.${name}`);
    if (raw.enabled === undefined) raw.enabled = true;
    if (typeof raw.enabled !== 'boolean') invalidConfig(`providers.${name}.enabled`, 'must be boolean');
    // Disabled placeholders do not need credentials or runner settings, but cannot enter priority.
    if (!raw.enabled) continue;
    validateRunnerTarget(raw['runs-on']);
    if (name === 'self-hosted') continue;
    assertFiniteNumber(raw['free-minutes'], `providers.${name}.free-minutes`, true);
    if (raw['reserve-percent'] === undefined) raw['reserve-percent'] = 5;
    assertFiniteNumber(raw['reserve-percent'], `providers.${name}.reserve-percent`, true);
    if (raw['reserve-percent'] >= 100) invalidConfig(`providers.${name}.reserve-percent`, 'must be less than 100');
    const cycle = raw['billing-cycle'];
    if (!isConfigObject(cycle)) invalidConfig(`providers.${name}.billing-cycle`, 'requires an explicit UTC monthly anchor');
    assertConfigKeys(cycle, ['anchor'], `providers.${name}.billing-cycle`);
    if (typeof cycle.anchor !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(cycle.anchor) || !Number.isFinite(Date.parse(cycle.anchor)) || new Date(cycle.anchor).toISOString() !== cycle.anchor.replace('Z', '.000Z')) {
      invalidConfig(`providers.${name}.billing-cycle.anchor`, 'must be a real UTC date YYYY-MM-DDTHH:mm:ssZ');
    }
    if (name === 'github') {
      const date = new Date(cycle.anchor);
      if (date.getUTCDate() !== 1 || date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds()) invalidConfig('providers.github.billing-cycle.anchor', 'must be a UTC calendar-month boundary supported by the billing API');
      if (!isConfigObject(raw['sku-minute-multipliers']) || Object.keys(raw['sku-minute-multipliers']).length === 0) invalidConfig('providers.github.sku-minute-multipliers', 'requires verified SKU-to-allowance conversion factors');
      for (const multiplier of Object.values(raw['sku-minute-multipliers'])) assertFiniteNumber(multiplier, 'providers.github.sku-minute-multipliers', true);
    }
  }
  for (const name of priority) {
    const provider = value.providers[name];
    if (!isConfigObject(provider) || provider.enabled !== true) invalidConfig('priority', 'references a missing or disabled provider');
  }
  return { ...value, priority } as unknown as OpenCiConfig;
}
