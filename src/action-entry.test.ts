import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { parseRunnerConfig, resolveRunnerConfig } from './runner-config.ts';

async function runBundledAction(policy: object, environment: Record<string, string> = {}, actionDirectory = '.') {
  const action = parse(await readFile(join(actionDirectory, 'action.yml'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'open-ci-action-test-'));
  try {
    const preload = join(directory, 'mock-github.cjs');
    const callsFile = join(directory, 'calls.jsonl');
    const outputFile = join(directory, 'output');
    const summaryFile = join(directory, 'summary');
    await writeFile(outputFile, '');
    await writeFile(summaryFile, '');
    await writeFile(callsFile, '');
    await writeFile(preload, `
      const fs = require('node:fs');
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(String(input))+'\\n');
        if (url.pathname === '/repos/example-org/app') return Response.json({full_name:'example-org/app',owner:{login:'example-org',type:process.env.TEST_OWNER_TYPE || 'Organization'},private:process.env.TEST_PUBLIC !== 'true'});
        if (url.pathname.includes('/contents/')) {
          if (url.searchParams.get('ref') !== 'a'.repeat(40)) throw new Error('wrong config commit');
          if (process.env.TEST_FILE_MISSING === 'true') return Response.json({}, {status:404});
          const content = process.env.TEST_POLICY;
          return Response.json({type:'file',encoding:'base64',content:Buffer.from(content).toString('base64'),size:Buffer.byteLength(content)});
        }
        if (url.pathname.endsWith('/settings/billing/usage/summary')) return Response.json({organization:'example-org',timePeriod:{year:Number(url.searchParams.get('year')),month:Number(url.searchParams.get('month'))},usageItems:[{product:'Actions',unitType:'minutes',sku:'actions_linux',grossQuantity:99999}]});
        if (url.pathname.endsWith('/settings/billing/usage')) return Response.json({usageItems:[{product:'Actions',unitType:'Minutes',repositoryName:'app'}]});
        throw new Error('unexpected network call');
      };
    `);
    const result = spawnSync(process.execPath, ['--require', preload, resolve(actionDirectory, action.runs.main)], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GITHUB_REPOSITORY: 'example-org/app', GITHUB_SHA: 'a'.repeat(40),
        GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile,
        'INPUT_GITHUB-TOKEN': 'synthetic-repository-token',
        TEST_POLICY: JSON.stringify(policy), TEST_CALLS: callsFile,
        ...environment,
      }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const rawOutput = await readFile(outputFile, 'utf8');
    const outputs: Record<string, string> = {};
    const lines = rawOutput.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const [name, delimiter] = (lines[i] ?? '').split('<<');
      if (!name || !delimiter) continue;
      const values: string[] = [];
      while (++i < lines.length && lines[i] !== delimiter) values.push(lines[i]!);
      outputs[name] = values.join('\n');
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs, summary: await readFile(summaryFile, 'utf8'), calls: (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value) as string) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('packaged action emits all three runner forms through real GitHub output files', async () => {
  for (const target of ['self-hosted', ['self-hosted', 'linux'], { group: 'ci', labels: ['linux', 'x64'] }]) {
    const result = await runBundledAction({ priority: ['self-hosted'], providers: { 'self-hosted': { 'runs-on': target } } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.outputs.provider, 'self-hosted');
    assert.deepEqual(JSON.parse(result.outputs['runs-on']!), target);
    assert.match(result.outputs.reason!, /no usage quota/);
    assert.equal(result.calls.length, 2);
  }
});

test('root and existing subdirectory actions share inputs, outputs, executable bundles, and cleanup', async () => {
  const root = parse(await readFile('action.yml', 'utf8'));
  const existing = parse(await readFile('action/action.yml', 'utf8'));
  assert.deepEqual(root.inputs, existing.inputs);
  assert.deepEqual(root.outputs, existing.outputs);
  assert.equal(root.runs.using, 'node24');
  assert.equal(root.runs['post-if'], 'always()');
  assert.equal(existing.runs['post-if'], root.runs['post-if']);
  for (const phase of ['main', 'post']) {
    assert.equal(resolve(root.runs[phase]), resolve('action', existing.runs[phase]));
    assert.ok((await readFile(root.runs[phase], 'utf8')).length > 0);
  }
  const policy = { priority: ['self-hosted'], providers: { 'self-hosted': { 'runs-on': 'self-hosted' } } };
  for (const directory of ['.', 'action']) {
    const result = await runBundledAction(policy, {}, directory);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.outputs.provider, 'self-hosted');
    assert.equal(JSON.parse(result.outputs['runs-on']!), 'self-hosted');
  }
});

test('packaged action falls back across exhausted usage and missing credentials, retaining summary evidence', async () => {
  const example = parse(await readFile('examples/open-ci.yml', 'utf8'));
  const result = await runBundledAction(example, { 'INPUT_BILLING-TOKEN': 'synthetic-billing-token' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs.provider, 'self-hosted');
  assert.match(result.outputs.reason!, /99999/);
  assert.match(result.outputs.reason!, /organization token is required/);
  assert.match(result.summary, /queried/);
  assert.equal(result.calls.length, 5);
  assert.ok(!result.summary.includes('synthetic-billing-token'));
});

test('packaged action fails every-unavailable selection and unsupported personal repositories', async () => {
  const example = parse(await readFile('examples/open-ci.yml', 'utf8'));
  const result = await runBundledAction(example, { INPUT_PRIORITY: '["github","blacksmith"]' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.outputs, {});
  assert.match(result.stdout, /no configured provider is available/);
  assert.match(result.summary, /authentication unavailable/);
  const personal = await runBundledAction({}, { TEST_OWNER_TYPE: 'User' });
  assert.equal(personal.status, 1);
  assert.match(personal.stdout, /organization-owned/);
  assert.equal(personal.calls.length, 1);
});

test('packaged action supports Variable-only policy and rejects an absent explicitly named file', async () => {
  const policy = await readFile('examples/self-hosted-only.yml', 'utf8');
  const input = JSON.stringify(parse(policy));
  const optional = await runBundledAction({}, { INPUT_CONFIG: input, TEST_FILE_MISSING: 'true' });
  assert.equal(optional.status, 0);
  const explicit = await runBundledAction({}, { INPUT_CONFIG: input, TEST_FILE_MISSING: 'true', 'INPUT_CONFIG-PATH': '.github/open-ci.yml' });
  assert.equal(explicit.status, 1);
  assert.match(explicit.stdout, /explicitly requested path/);
});

test('published workflow contract binds same-commit code, explicit secrets, and selection outputs', async () => {
  const workflow = parse(await readFile('.github/workflows/select-runner.yml', 'utf8'));
  const action = parse(await readFile('action/action.yml', 'utf8'));
  const step = workflow.jobs.select.steps[0];
  assert.equal(step.uses, '$/action');
  assert.equal(action.runs.using, 'node24');
  assert.equal(action.runs.post, 'dist/cleanup.cjs');
  assert.equal(action.runs['post-if'], 'always()');
  for (const name of ['provider', 'runs-on', 'reason']) {
    assert.ok(action.outputs[name]);
    assert.equal(workflow.jobs.select.outputs[name], '${{ steps.select.outputs.' + name + ' }}');
    assert.equal(workflow.on.workflow_call.outputs[name].value, '${{ jobs.select.outputs.' + name + ' }}');
  }
  for (const name of Object.keys(step.with)) assert.ok(action.inputs[name], name);
  assert.equal(step.with['github-token'], '${{ github.token }}');
  assert.equal(workflow.permissions.contents, 'read');
  assert.match(workflow.jobs.select['runs-on'], /OPEN_CI_SELECTOR_RUNS_ON/);
});

test('repository examples satisfy the runtime policy contract', async () => {
  for (const file of ['examples/open-ci.yml', 'examples/self-hosted-only.yml']) {
    const policy = parseRunnerConfig(await readFile(file, 'utf8'), 'yaml');
    assert.ok(resolveRunnerConfig({}, policy).priority.length > 0);
  }
  assert.equal(JSON.parse(await readFile('schema/open-ci.schema.json', 'utf8')).properties.version.const, 1);
});
