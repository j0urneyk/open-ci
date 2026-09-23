import { cleanupBlacksmithDirectory } from './blacksmith-cleanup.ts';

const directory = process.env.STATE_blacksmithDirectory;
if (directory) {
  cleanupBlacksmithDirectory(directory).catch(() => {
    process.stdout.write('::error::Open CI cleanup failed: temporary Blacksmith credentials could not be removed.\n');
    process.exitCode = 1;
  });
}
