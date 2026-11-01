import { readFile, rm } from 'node:fs/promises';
import type { QboEnvironment } from '../config.ts';
import { NotAuthorizedError, TokenPersistError, WrongPassphraseError } from '../errors.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { DEFAULT_KDF, deriveKey, kdfParamsOf, newSalt, seal, unseal, type KdfParams, type SealedBox } from './crypto.ts';
import type { PassphraseProvider } from './passphrase.ts';

export interface StoredTokens {
  realmId: string;
  environment: QboEnvironment;
  accessToken: string;
  /** ISO timestamp. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** ISO timestamp, or null if Intuit did not say. */
  refreshTokenExpiresAt: string | null;
  /** ISO timestamp of when this pair was issued; used to pick the newest copy. */
  obtainedAt: string;
}

/**
 * Encrypted on-disk token store. The passphrase is asked for at most once per
 * process; the derived key is cached in memory so post-refresh saves never
 * block on a prompt.
 *
 * If the main file can't be written, save() falls back to an encrypted
 * `.recovery` sibling so a freshly rotated refresh token is never lost;
 * load() always picks whichever copy is newest.
 */
export class TokenStore {
  readonly path: string;
  readonly recoveryPath: string;
  private readonly passphrase: PassphraseProvider;
  private readonly kdf: KdfParams;
  private key: Buffer | undefined;
  private salt: Buffer | undefined;
  private keyParams: KdfParams | undefined;

  constructor(path: string, passphrase: PassphraseProvider, kdf: KdfParams = DEFAULT_KDF) {
    this.path = path;
    this.recoveryPath = `${path}.recovery`;
    this.passphrase = passphrase;
    this.kdf = kdf;
  }

  async exists(): Promise<boolean> {
    return (await readBox(this.path)) !== undefined || (await readBox(this.recoveryPath)) !== undefined;
  }

  async load(): Promise<StoredTokens> {
    const boxes = [await readBox(this.path), await readBox(this.recoveryPath)].filter((b): b is SealedBox => !!b);
    if (boxes.length === 0) throw new NotAuthorizedError();
    let newest: StoredTokens | undefined;
    for (const box of boxes) {
      await this.unlock(box);
      const tokens = JSON.parse(unseal(this.key!, box).toString('utf8')) as StoredTokens;
      if (!newest || tokens.obtainedAt > newest.obtainedAt) newest = tokens;
    }
    return newest!;
  }

  async save(tokens: StoredTokens): Promise<void> {
    if (!this.key) {
      const existing = (await readBox(this.path)) ?? (await readBox(this.recoveryPath));
      if (existing) {
        await this.unlock(existing);
      } else {
        this.salt = newSalt();
        this.keyParams = this.kdf;
        this.key = await deriveKey(await this.passphrase({ creating: true }), this.salt, this.kdf);
      }
    }
    const body = JSON.stringify(seal(this.key!, this.salt!, this.keyParams!, Buffer.from(JSON.stringify(tokens), 'utf8')));
    try {
      await writeFileAtomic(this.path, body, { mode: 0o600 });
    } catch (primaryErr) {
      try {
        await writeFileAtomic(this.recoveryPath, body, { mode: 0o600 });
      } catch {
        throw new TokenPersistError(
          `Could not save refreshed QuickBooks tokens to ${this.path} (${(primaryErr as Error).message}). ` +
            'The previous refresh token is no longer valid, so you will need to re-run `auth`.',
        );
      }
      return;
    }
    // Main file is current again; a stale recovery copy would only cause confusion.
    await rm(this.recoveryPath, { force: true });
  }

  /** Deletes the stored tokens (used by `auth --reset`). */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    await rm(this.recoveryPath, { force: true });
    this.key = this.salt = this.keyParams = undefined;
  }

  private async unlock(box: SealedBox): Promise<void> {
    const { salt, params } = kdfParamsOf(box);
    if (this.key && this.salt?.equals(salt)) return;
    const key = await deriveKey(await this.passphrase({ creating: false }), salt, params);
    unseal(key, box); // throws WrongPassphraseError on mismatch
    this.key = key;
    this.salt = salt;
    this.keyParams = params;
  }
}

async function readBox(path: string): Promise<SealedBox | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as SealedBox;
  } catch {
    throw new WrongPassphraseError();
  }
}
