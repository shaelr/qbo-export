import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { WrongPassphraseError } from '../errors.ts';

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

// ~128 MiB of memory and roughly 0.3-0.5 s per derivation: slow enough to
// make offline guessing expensive, and we derive only once per run.
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_LENGTH = 32;
// Binds ciphertext to this purpose so a blob from elsewhere can't be swapped in.
const AAD = Buffer.from('qbo-export/token-store/v1');

export interface SealedBox {
  v: 1;
  kdf: { name: 'scrypt'; salt: string } & KdfParams;
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export function deriveKey(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFC'), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

export function seal(key: Buffer, salt: Buffer, params: KdfParams, plaintext: Buffer): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    kdf: { name: 'scrypt', salt: salt.toString('base64'), ...params },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function unseal(key: Buffer, box: SealedBox): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  } catch {
    throw new WrongPassphraseError();
  }
}

export function kdfParamsOf(box: SealedBox): { salt: Buffer; params: KdfParams } {
  if (box.v !== 1 || box.kdf?.name !== 'scrypt' || box.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported token store format.');
  }
  return { salt: Buffer.from(box.kdf.salt, 'base64'), params: { N: box.kdf.N, r: box.kdf.r, p: box.kdf.p } };
}
