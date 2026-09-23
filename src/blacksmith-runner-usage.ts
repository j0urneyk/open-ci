import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { calculateBillingPeriod } from './billing-period.ts';
import { registerBlacksmithCleanup, cleanupBlacksmithDirectory } from './blacksmith-cleanup.ts';
import { evaluateUsageAllowance } from './runner-selection.ts';
import { OpenCiCancellationError, ProviderQueryError, type BlacksmithProviderConfig, type ProviderEvaluation } from './runner-contract.ts';

const BLACKSMITH_VERSION = '0.4.60';
const BLACKSMITH_LINUX_SHA256 = '5ace4f255ae26b59c230ab8b22ee584f726266d7c1abebda2a953c27224065c0';

/** Blacksmith CLI transport keeps machine credentials isolated from any existing human login. */
export interface BlacksmithTransport {
  install: (directory: string) => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  platform: string;
  arch: string;
  run: (executable: string, args: string[], credentialDirectory: string, stdin?: string) => Promise<string>;
}

/** Download one pinned Linux x64 CLI, rejecting changed content before any execution. */
export async function installBlacksmithCli(directory: string, fetchBinary: typeof fetch = globalThis.fetch, sleep: (milliseconds: number) => Promise<void> = delay): Promise<string> {
  const executable = join(directory, 'blacksmith');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchBinary(`https://clireleases.blacksmith.sh/cli/v${BLACKSMITH_VERSION}/linux/amd64/blacksmith`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('download status'); }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 100 * 1024 * 1024 || createHash('sha256').update(buffer).digest('hex') !== BLACKSMITH_LINUX_SHA256) throw new ProviderQueryError('Blacksmith CLI invalid: pinned binary checksum mismatch.');
      await writeFile(executable, buffer, { mode: 0o700 });
      await chmod(executable, 0o700);
      return executable;
    } catch (error) {
      if (error instanceof ProviderQueryError) throw error;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
    }
  }
  throw new ProviderQueryError('Blacksmith CLI unavailable: pinned binary could not be downloaded.');
}

/** Run only the pinned CLI, with bounded output/time and no inherited provider credentials. */
export async function runBlacksmithCommand(executable: string, args: string[], credentialDirectory: string, stdin?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      cwd: credentialDirectory,
      // HOME is the child's credential sandbox; the parent process environment is unchanged.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: credentialDirectory, BLACKSMITH_DISABLE_AUTO_UPDATE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let bytes = 0;
    let failed = false;
    let cancelled = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const cancel = () => { cancelled = true; child.kill('SIGKILL'); };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const removeCancellationHandlers = () => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); };
    const timer = setTimeout(fail, 30_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) fail(); else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) fail(); });
    child.on('error', () => { clearTimeout(timer); removeCancellationHandlers(); reject(new ProviderQueryError('Blacksmith CLI unavailable: process could not start.')); });
    child.on('close', code => {
      clearTimeout(timer);
      removeCancellationHandlers();
      if (cancelled) reject(new OpenCiCancellationError('Open CI execution cancelled: Blacksmith subprocess terminated.'));
      else if (failed || code !== 0) reject(new ProviderQueryError('Blacksmith CLI unavailable: command failed, timed out, or exceeded output limits.'));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

function blacksmithObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderQueryError('Blacksmith usage invalid: expected an object.');
  return value as Record<string, unknown>;
}

/** Convert CLI billing minutes (weighted vCPU minutes) into x64 Linux 2-vCPU allowance minutes. */
export function normalizeBlacksmithUsage(payload: unknown, owner: string, start: Date, end: Date): number {
  const result = blacksmithObject(payload);
  const installation = blacksmithObject(result.installation);
  if (typeof installation.installation_name !== 'string' || installation.installation_name.toLowerCase() !== owner.toLowerCase() || !Number.isSafeInteger(installation.installation_model_id) || Number(installation.installation_model_id) <= 0) throw new ProviderQueryError('Blacksmith usage invalid: response organization does not match the caller.');
  // The echoed query window cannot establish the provider's actual free-tier reset schedule.
  const window = blacksmithObject(result.window);
  if (typeof window.start !== 'string' || typeof window.end !== 'string' || Date.parse(window.start) !== start.getTime() || Date.parse(window.end) !== end.getTime()) throw new ProviderQueryError('Blacksmith usage invalid: response billing window does not match the requested period.');
  const summary = blacksmithObject(result.summary);
  if (typeof summary.billing_minutes !== 'number' || !Number.isFinite(summary.billing_minutes) || summary.billing_minutes < 0) throw new ProviderQueryError('Blacksmith usage invalid: missing normalized billing_minutes.');
  return summary.billing_minutes / 2;
}

/** Evaluate Blacksmith through a checksum-pinned CLI and remove its temporary token store afterward. */
export async function evaluateBlacksmithRunner(config: BlacksmithProviderConfig, owner: string, token: string, now = new Date(), transport: BlacksmithTransport = { install: installBlacksmithCli, sleep: delay, platform: process.platform, arch: process.arch, run: runBlacksmithCommand }): Promise<ProviderEvaluation> {
  if (!token) throw new ProviderQueryError('Blacksmith authentication unavailable: an organization token is required.');
  if (transport.platform !== 'linux' || transport.arch !== 'x64') throw new ProviderQueryError('Blacksmith CLI unavailable: this release packages the Linux x64 selector binary.');
  // The CLI reports whole seconds; request that precision so strict window validation remains meaningful.
  const queryTime = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const period = calculateBillingPeriod(config['billing-cycle'], queryTime);
  // Hardened self-hosted runners may mount /tmp noexec; use the job's executable temporary directory.
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'open-ci-blacksmith-'));
  try {
    // Register before authentication so post cleanup can remove credentials if cancellation bypasses finally.
    await registerBlacksmithCleanup(directory);
    const executable = await transport.install(directory);
    const version = await transport.run(executable, ['--version'], directory);
    if (version.trim() !== `blacksmith version ${BLACKSMITH_VERSION}`) throw new ProviderQueryError('Blacksmith CLI invalid: unexpected version.');
    await transport.run(executable, ['auth', 'login', '--api-token', '-', '--non-interactive', '--organization', owner], directory, token);
    let stdout = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        stdout = await transport.run(executable, ['usage', '--org', owner, '--start-time', period.start.toISOString(), '--end-time', period.end.toISOString(), '--format', 'json', '--breakdown-by', 'day'], directory);
        break;
      } catch (error) {
        if (!(error instanceof ProviderQueryError)) throw error;
        if (attempt === 2) throw error;
        await transport.sleep(500 * 2 ** attempt);
      }
    }
    let payload: unknown;
    try { payload = JSON.parse(stdout); } catch { throw new ProviderQueryError('Blacksmith usage invalid: CLI output is not JSON.'); }
    const usedMinutes = normalizeBlacksmithUsage(payload, owner, period.start, period.end);
    return evaluateUsageAllowance({ usedMinutes, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(), checkedAt: now.toISOString() }, config['free-minutes'], config['reserve-percent']);
  } finally { await cleanupBlacksmithDirectory(directory); }
}
