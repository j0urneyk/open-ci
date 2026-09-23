import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cleanupBlacksmithDirectory, registerBlacksmithCleanup } from './blacksmith-cleanup.ts';

test('post action removes a registered leftover credential directory and refuses unrelated paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-ci-blacksmith-'));
  const unrelated = await mkdtemp(join(tmpdir(), 'open-ci-unrelated-'));
  try {
    const state = join(unrelated, 'state');
    await writeFile(join(directory, 'credentials'), 'synthetic-token');
    await registerBlacksmithCleanup(directory, state);
    assert.equal(await readFile(state, 'utf8'), `blacksmithDirectory=${directory}\n`);
    const post = spawnSync(process.execPath, [resolve('action/dist/cleanup.cjs')], {
      env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), STATE_blacksmithDirectory: directory }, encoding: 'utf8',
    });
    assert.equal(post.status, 0, post.stdout + post.stderr);
    await assert.rejects(access(directory));
    await cleanupBlacksmithDirectory(directory);
    await assert.rejects(cleanupBlacksmithDirectory(unrelated), /not an owned/);
    await access(unrelated);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(unrelated, { recursive: true, force: true }); }
});

test('termination stops the active CLI and permits credential cleanup instead of a silent fallback', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-ci-blacksmith-'));
  const workerFile = join(directory, 'worker.mjs');
  await writeFile(join(directory, 'credentials'), 'synthetic-token');
  await writeFile(workerFile, `
    import {runBlacksmithCommand} from ${JSON.stringify(pathToFileURL(resolve('src/blacksmith-runner-usage.ts')).href)};
    import {cleanupBlacksmithDirectory} from ${JSON.stringify(pathToFileURL(resolve('src/blacksmith-cleanup.ts')).href)};
    const directory=${JSON.stringify(directory)};
    const command=runBlacksmithCommand(process.execPath,['-e','setInterval(()=>{},1000)'],directory);
    process.stdout.write('ready\\n');
    try {await command;process.exitCode=1;} catch(error){process.stdout.write(error.name+'\\n');process.exitCode=42;}
    finally {await cleanupBlacksmithDirectory(directory);}
  `);
  const worker = spawn(process.execPath, [workerFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(worker, 'close');
  let output = '';
  worker.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    await once(worker.stdout, 'data');
    assert.match(output, /ready/);
    worker.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 42);
    assert.match(output, /OpenCiCancellationError/);
    await assert.rejects(access(directory));
  } finally { worker.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
