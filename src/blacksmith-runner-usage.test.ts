import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluateBlacksmithRunner, installBlacksmithCli, normalizeBlacksmithUsage, runBlacksmithCommand, type BlacksmithTransport } from './blacksmith-runner-usage.ts';
import { resolveRunnerConfig } from './runner-config.ts';
import { OpenCiCancellationError, ProviderQueryError } from './runner-contract.ts';

const now = new Date('2026-09-22T12:00:00.000Z');
const start = new Date('2026-09-01T00:00:00.000Z');
const report = (minutes: unknown) => ({ installation: { installation_name: 'example-org', installation_model_id: 123 }, window: { start: start.toISOString(), end: now.toISOString() }, summary: { billing_minutes: minutes, runtime_minutes: 10, billable_minutes: 20 } });
const config = () => resolveRunnerConfig({ priority: ['blacksmith'], providers: { blacksmith: { 'runs-on': 'blacksmith-2vcpu-ubuntu-2404', 'free-minutes': 3000, 'billing-cycle': { anchor: '2026-01-01T00:00:00Z' } } } }, {}).providers.blacksmith!;

test('converts weighted vCPU minutes, not wall-clock minutes, to 2-vCPU allowance units', () => {
  assert.equal(normalizeBlacksmithUsage(report(40), 'example-org', start, now), 20);
  assert.equal(normalizeBlacksmithUsage(report(12.5), 'example-org', start, now), 6.25);
  assert.equal(normalizeBlacksmithUsage(report(0), 'example-org', start, now), 0);
  for (const value of [undefined, '100', -1, NaN]) assert.throws(() => normalizeBlacksmithUsage(report(value), 'example-org', start, now));
  assert.throws(() => normalizeBlacksmithUsage({ ...report(2), window: { start: '2026-08-01T00:00:00Z', end: now.toISOString() } }, 'example-org', start, now), /window/);
  assert.throws(() => normalizeBlacksmithUsage(report(20), 'wrong-org', start, now), /organization/);
});

test('authenticates through stdin, queries the absolute organization window and cleans up the credential directory', async () => {
  let directory = '';
  const commands: string[][] = [];
  const transport: BlacksmithTransport = {
    platform: 'linux', arch: 'x64', sleep: async () => {},
    install: async path => { directory = path; return join(path, 'blacksmith'); },
    run: async (_file, args, path, input) => {
      assert.equal(path, directory);
      commands.push(args);
      if (args[0] === '--version') return 'blacksmith version 0.4.60\n';
      if (args[0] === 'auth') { assert.equal(input, 'synthetic-secret'); assert.equal(args.includes('synthetic-secret'), false); return ''; }
      assert.deepEqual(args, ['usage', '--org', 'example-org', '--start-time', start.toISOString(), '--end-time', now.toISOString(), '--format', 'json', '--breakdown-by', 'day']);
      return JSON.stringify(report(5700));
    },
  };
  const result = await evaluateBlacksmithRunner(config(), 'example-org', 'synthetic-secret', now, transport);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.usage?.usedMinutes, 2850);
  assert.equal(commands.length, 3);
  await assert.rejects(access(directory));
});

test('requests whole-second billing windows because the live CLI truncates timestamp fractions', async () => {
  const queriedAt = new Date('2026-09-22T12:00:00.123Z');
  let usageArguments: string[] = [];
  const transport: BlacksmithTransport = {
    platform: 'linux', arch: 'x64', sleep: async () => {}, install: async path => join(path, 'blacksmith'),
    run: async (_file, args) => {
      if (args[0] === '--version') return 'blacksmith version 0.4.60';
      if (args[0] === 'auth') return '';
      usageArguments = args;
      return JSON.stringify(report(274));
    },
  };
  const result = await evaluateBlacksmithRunner(config(), 'example-org', 'synthetic-token', queriedAt, transport);
  assert.equal(usageArguments[usageArguments.indexOf('--end-time') + 1], now.toISOString());
  assert.equal(result.usage?.usedMinutes, 137);
  assert.equal(result.usage?.periodEnd, now.toISOString());
  assert.equal(result.usage?.checkedAt, queriedAt.toISOString());
});

test('bounds CLI retries and still removes credentials on authentication or usage failure', async () => {
  let directory = '';
  let attempts = 0;
  const transport: BlacksmithTransport = {
    platform: 'linux', arch: 'x64', sleep: async () => {}, install: async path => { directory = path; return join(path, 'blacksmith'); },
    run: async (_file, args) => {
      if (args[0] === '--version') return 'blacksmith version 0.4.60';
      if (args[0] === 'auth') return '';
      attempts++;
      throw new ProviderQueryError('Blacksmith CLI unavailable: request failed.');
    },
  };
  await assert.rejects(evaluateBlacksmithRunner(config(), 'org', 'secret', now, transport), /request failed/);
  assert.equal(attempts, 3);
  await assert.rejects(access(directory));
});

test('uses the job runner temporary directory when the system temporary mount cannot execute binaries', async () => {
  const runnerTemporaryDirectory = await mkdtemp(join(tmpdir(), 'open-ci-runner-temp-test-'));
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemporaryDirectory;
  let directory = '';
  try {
    const transport: BlacksmithTransport = {
      platform: 'linux', arch: 'x64', sleep: async () => {},
      install: async path => {
        directory = path;
        assert.equal(dirname(path), runnerTemporaryDirectory);
        return join(path, 'blacksmith');
      },
      run: async (_file, args) => args[0] === '--version' ? 'blacksmith version 0.4.60' : args[0] === 'auth' ? '' : JSON.stringify(report(20)),
    };
    assert.equal((await evaluateBlacksmithRunner(config(), 'example-org', 'synthetic-token', now, transport)).state, 'available');
    await assert.rejects(access(directory));
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await rm(runnerTemporaryDirectory, { recursive: true, force: true });
  }
});

test('refuses altered CLI downloads without running them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-ci-download-test-'));
  try {
    let calls = 0;
    await assert.rejects(installBlacksmithCli(directory, async () => { calls++; return new Response('not the pinned binary'); }, async () => {}), /checksum/);
    assert.equal(calls, 1);
    await assert.rejects(access(join(directory, 'blacksmith')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation is not retried and the temporary directory is removed', async () => {
  let directory = '';
  let calls = 0;
  const transport: BlacksmithTransport = {
    platform: 'linux', arch: 'x64', sleep: async () => assert.fail('cancellation must not retry'), install: async path => { directory = path; return join(path, 'blacksmith'); },
    run: async (_file, args) => {
      if (args[0] === '--version') return 'blacksmith version 0.4.60';
      if (args[0] === 'auth') return '';
      calls++;
      throw new OpenCiCancellationError('Open CI execution cancelled: test signal.');
    },
  };
  await assert.rejects(evaluateBlacksmithRunner(config(), 'example-org', 'token', now, transport), OpenCiCancellationError);
  assert.equal(calls, 1);
  await assert.rejects(access(directory));
});

test('CLI subprocess receives only isolated credentials, and stderr is never returned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-ci-subprocess-test-'));
  try {
    const script = join(directory, 'fake-cli.cjs');
    await writeFile(script, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{process.stderr.write('secret-stderr');process.stdout.write(JSON.stringify({input,dir:process.env.HOME,autoUpdate:process.env.BLACKSMITH_DISABLE_AUTO_UPDATE,inherited:process.env.GITHUB_TOKEN}));});`);
    const result = JSON.parse(await runBlacksmithCommand(process.execPath, [script], directory, 'synthetic-token'));
    assert.deepEqual(result, { input: 'synthetic-token', dir: directory, autoUpdate: '1' });
    await writeFile(script, `process.stderr.write('private error payload');process.exit(1);`);
    await assert.rejects(runBlacksmithCommand(process.execPath, [script], directory), error => error instanceof Error && !error.message.includes('private error payload'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
