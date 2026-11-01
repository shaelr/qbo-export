import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archivePaths, initArchive, safeSegment } from '../src/archive/layout.ts';
import { writeFileAtomic } from '../src/util/atomic.ts';
import { acquireLock } from '../src/util/lockfile.ts';
import { numberText, parseLossless, stringifyLossless } from '../src/util/lossless-json.ts';
import { backoffDelay, parseRetryAfter, RetryableError, withRetry } from '../src/util/retry.ts';
import { fixture, tempDir } from './helpers.ts';

describe('lossless JSON', () => {
  it('keeps money values exactly as QBO sent them', async () => {
    const text = await fixture('sandbox/invoice-money.json');
    const parsed = parseLossless(text) as any;
    const inv = parsed.QueryResponse.Invoice[0];
    expect(numberText(inv.TotalAmt)).toBe('1130.10');
    expect(numberText(inv.Balance)).toBe('0.00');
    expect(numberText(inv.Line[0].SalesItemLineDetail.UnitPrice)).toBe('400.00');
    expect(stringifyLossless(inv)).toContain('"TotalAmt":1130.10');
    // Round-trips to identical bytes.
    expect(stringifyLossless(parsed)).toBe(text.trim());
  });

  it('preserves numbers beyond float precision', () => {
    expect(stringifyLossless(parseLossless('{"n":12345678901234567890.123}'))).toBe('{"n":12345678901234567890.123}');
  });
});

describe('retry/backoff', () => {
  it('backs off exponentially with jitter and a cap', () => {
    expect(backoffDelay(1, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(1, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(4, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    const now = Date.parse('2026-10-31T00:00:00Z');
    expect(parseRetryAfter('Sat, 31 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('retries RetryableError, honours retryAfter, and gives up after maxAttempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RetryableError('busy', 4000);
        if (calls === 2) throw new RetryableError('busy');
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, random: () => 1, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([4000, 200]);

    await expect(
      withRetry(async () => {
        throw new RetryableError('always');
      }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow('always');
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('fatal');
      }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});

describe('atomic write and lock file', () => {
  it('writes files atomically with the requested mode and no temp files left behind', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secret.json');
    await writeFileAtomic(path, 'one', { mode: 0o600 });
    await writeFileAtomic(path, 'two', { mode: 0o600 });
    expect(await readFile(path, 'utf8')).toBe('two');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secret.json']);
  });

  it('serializes lock holders and takes over locks from dead processes', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'x.lock');
    const release = await acquireLock(lock);
    let second = false;
    const waiting = acquireLock(lock, { pollMs: 5 }).then((r) => {
      second = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(second).toBe(false);
    await release();
    await (await waiting)();

    await writeFileAtomic(lock, '999999999'); // PID that cannot exist
    const stolen = await acquireLock(lock, { timeoutMs: 500 });
    expect(await readFile(lock, 'utf8')).toBe(String(process.pid));
    await stolen();
  });
});

describe('archive layout', () => {
  it('creates the folder structure and a catch-all .gitignore', async () => {
    const root = join(await tempDir(), 'archive');
    const paths = await initArchive(root);
    expect(await readFile(paths.gitignore, 'utf8')).toMatch(/^\*$/m);
    expect((await stat(paths.raw)).isDirectory()).toBe(true);
    expect(paths.rawRecord('Invoice', '130')).toBe(join(root, 'raw', 'Invoice', '130.json'));
  });

  it('keeps ids and filenames inside the archive', () => {
    expect(safeSegment('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('Receipt 2024-03 (1).pdf')).toBe('Receipt 2024-03 (1).pdf');
    expect(archivePaths('/a').attachmentFile('5', 'x/y.png')).toBe(join('/a', 'attachments', '5', 'x_y.png'));
  });
});
