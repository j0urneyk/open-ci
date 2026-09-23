import { appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

function validateBlacksmithDirectory(directory: string): string {
  const path = resolve(directory);
  const allowedRoots = [resolve(tmpdir()), ...(process.env.RUNNER_TEMP ? [resolve(process.env.RUNNER_TEMP)] : [])];
  if (!allowedRoots.includes(dirname(path)) || !/^open-ci-blacksmith-[A-Za-z0-9]+$/.test(basename(path))) throw new Error('Open CI cleanup refused: directory is not an owned Blacksmith temporary path.');
  return path;
}

/** Persist the owned credential path in action state before any organization token is written. */
export async function registerBlacksmithCleanup(directory: string, stateFile = process.env.GITHUB_STATE): Promise<void> {
  const path = validateBlacksmithDirectory(directory);
  if (stateFile) await appendFile(stateFile, `blacksmithDirectory=${path}\n`);
}

/** Remove only this action's temporary Blacksmith directory, including in the post action. */
export async function cleanupBlacksmithDirectory(directory: string): Promise<void> {
  await rm(validateBlacksmithDirectory(directory), { recursive: true, force: true });
}
