import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for the new file, e.g. 0o600 for secrets. */
  mode?: number;
}

/**
 * Writes `data` to `path` so that readers see either the old file or the
 * complete new one, never a partial write: temp file in the same directory,
 * fsync, rename over the target, then fsync the directory so the rename
 * itself survives a crash.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', options.mode ?? 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dir);
}

async function fsyncDir(dir: string): Promise<void> {
  let dh;
  try {
    dh = await open(dir, 'r');
    await dh.sync();
  } catch {
    // Some platforms/filesystems refuse fsync on directories; the rename is still atomic.
  } finally {
    await dh?.close();
  }
}
