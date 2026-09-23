import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

const exampleDirectory = 'examples/shared-selection';

interface ExampleWorkflow {
  on: Record<string, { inputs?: Record<string, { type: string; required?: boolean }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    needs?: string;
    if?: string;
    uses?: string;
    'runs-on'?: string;
    with?: Record<string, string>;
    secrets?: unknown;
    outputs?: Record<string, string>;
    steps?: { uses?: string }[];
  }>;
}

async function readExampleWorkflow(filename: string): Promise<ExampleWorkflow> {
  const document = parseDocument(await readFile(join(exampleDirectory, filename), 'utf8'));
  assert.deepEqual(document.errors, [], filename);
  return document.toJS() as ExampleWorkflow;
}

test('shared selection examples resolve both local calls after copying workflows flat', async () => {
  const parent = await readExampleWorkflow('ci.yml');
  const files = (await readdir(exampleDirectory)).filter(name => name.endsWith('.yml'));
  assert.deepEqual(Object.keys(parent.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(parent.permissions, { contents: 'read' });
  const selector = parent.jobs['select-runner']!;
  assert.match(selector.if!, /head.repo.full_name == github.repository/);
  assert.equal(selector.outputs?.runner, '${{ steps.select.outputs.runs-on }}');
  const calls = Object.values(parent.jobs).filter(job => job.uses);
  assert.equal(calls.length, 2);
  const referencedFiles = new Set(['ci.yml']);
  for (const call of calls) {
    assert.match(call.uses!, /^\.\/\.github\/workflows\/[^/]+\.yml$/);
    const filename = basename(call.uses!);
    assert.ok(files.includes(filename), call.uses);
    referencedFiles.add(filename);
    assert.equal(call.needs, 'select-runner');
    assert.equal(call.if, "needs.select-runner.result == 'success' && needs.select-runner.outputs.runner != ''");
    assert.equal(call['runs-on'], undefined);
    assert.equal(call.secrets, undefined);
    assert.deepEqual(call.with, { runner: '${{ needs.select-runner.outputs.runner }}' });
    const child = await readExampleWorkflow(filename);
    assert.deepEqual(Object.keys(child.on), ['workflow_call']);
    assert.deepEqual(child.on.workflow_call?.inputs, { runner: {
      description: 'JSON runner target selected by the caller', required: true, type: 'string',
    } });
    assert.equal('secrets' in child.on.workflow_call!, false);
    assert.deepEqual(child.permissions, { contents: 'read' });
    for (const job of Object.values(child.jobs)) {
      assert.equal(job['runs-on'], '${{ fromJSON(inputs.runner) }}');
      assert.equal(job.uses, undefined);
      assert.ok(job.steps?.every(step => !step.uses?.startsWith('j0urneyk/open-ci')));
    }
  }
  assert.deepEqual([...referencedFiles].sort(), files.sort());
  assert.equal(Object.values(parent.jobs).flatMap(job => job.steps ?? [])
    .filter(step => step.uses === 'j0urneyk/open-ci@v1').length, 1);
});
