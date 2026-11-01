import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep } from './retry.ts';

export interface LockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Cross-process mutex via an O_EXCL lock file holding the owner's PID.
 * A lock left behind by a dead process is taken over. Returns a release function.
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      const fh = await open(path, 'wx', 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return async () => {
        await rm(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = Number((await readFile(path, 'utf8').catch(() => '')).trim());
    if (!Number.isInteger(owner) || owner <= 0 || !isAlive(owner)) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock ${path} (held by PID ${owner}). Is another qbo-export running?`);
    }
    await sleep(pollMs);
  }
}
