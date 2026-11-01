import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../src/auth/token-store.ts';
import { NotAuthorizedError, TokenPersistError, WrongPassphraseError } from '../src/errors.ts';
import { sampleTokens, TEST_KDF, tempDir } from './helpers.ts';

const pass = (value: string) => vi.fn(async () => value);

describe('TokenStore', () => {
  it('round-trips tokens and never writes them in plaintext', async () => {
    const path = join(await tempDir(), 'tokens.enc.json');
    const store = new TokenStore(path, pass('correct horse battery'), TEST_KDF);
    await store.save(sampleTokens());

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('RT-secret-refresh-1');
    expect(raw).not.toContain('AT-secret-access-1');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const fresh = new TokenStore(path, pass('correct horse battery'), TEST_KDF);
    expect(await fresh.load()).toEqual(sampleTokens());
  });

  it('asks for the passphrase once per process, including across saves', async () => {
    const path = join(await tempDir(), 'tokens.enc.json');
    const provider = pass('correct horse battery');
    const store = new TokenStore(path, provider, TEST_KDF);
    await store.save(sampleTokens());
    await store.save(sampleTokens({ refreshToken: 'RT-2' }));
    await store.load();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ creating: true });
  });

  it('rejects a wrong passphrase', async () => {
    const path = join(await tempDir(), 'tokens.enc.json');
    await new TokenStore(path, pass('correct horse battery'), TEST_KDF).save(sampleTokens());
    await expect(new TokenStore(path, pass('wrong passphrase!!'), TEST_KDF).load()).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('detects tampering', async () => {
    const path = join(await tempDir(), 'tokens.enc.json');
    await new TokenStore(path, pass('correct horse battery'), TEST_KDF).save(sampleTokens());
    const box = JSON.parse(await readFile(path, 'utf8'));
    const data = Buffer.from(box.data, 'base64');
    data[0] = data[0]! ^ 1;
    box.data = data.toString('base64');
    await writeFile(path, JSON.stringify(box));
    await expect(new TokenStore(path, pass('correct horse battery'), TEST_KDF).load()).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('reports not-authorized when nothing is stored', async () => {
    const store = new TokenStore(join(await tempDir(), 'none.enc.json'), pass('x'), TEST_KDF);
    await expect(store.load()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it('falls back to an encrypted recovery file when the main file cannot be written, and load prefers the newest', async () => {
    const dir = await tempDir();
    const path = join(dir, 'tokens.enc.json');
    const store = new TokenStore(path, pass('correct horse battery'), TEST_KDF);
    await store.save(sampleTokens());

    // Make the main target unwritable by replacing it with a non-empty directory.
    await writeFile(path + '.bak', await readFile(path));
    await rm(path);
    await mkdir(join(path, 'blocker'), { recursive: true });

    const newer = sampleTokens({ refreshToken: 'RT-rotated-2', obtainedAt: '2026-10-31T13:00:00.000Z' });
    await store.save(newer);
    const recovery = await readFile(store.recoveryPath, 'utf8');
    expect(recovery).not.toContain('RT-rotated-2');

    await rm(path, { recursive: true });
    await writeFile(path, await readFile(path + '.bak'));
    const reloaded = new TokenStore(path, pass('correct horse battery'), TEST_KDF);
    expect((await reloaded.load()).refreshToken).toBe('RT-rotated-2');
  });

  it('throws TokenPersistError when neither file can be written', async () => {
    const dir = join(await tempDir(), 'locked');
    await mkdir(dir);
    const store = new TokenStore(join(dir, 'tokens.enc.json'), pass('correct horse battery'), TEST_KDF);
    await chmod(dir, 0o500);
    try {
      await expect(store.save(sampleTokens())).rejects.toBeInstanceOf(TokenPersistError);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
