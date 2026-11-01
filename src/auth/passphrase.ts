import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { UserFacingError } from '../errors.ts';

export const MIN_PASSPHRASE_LENGTH = 12;

export type PassphraseProvider = (options: { creating: boolean }) => Promise<string>;

/** Reads a line from the terminal without echoing it. Prompts go to stderr. */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UserFacingError('A passphrase is required, but stdin is not an interactive terminal.');
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write(question);
    muted = true;
    return await rl.question('');
  } finally {
    muted = false;
    rl.close();
    process.stderr.write('\n');
  }
}

/** Interactive passphrase provider: asks twice when creating a new token store. */
export const terminalPassphrase: PassphraseProvider = async ({ creating }) => {
  if (!creating) return promptHidden('Token store passphrase: ');
  process.stderr.write(
    'Choose a passphrase to encrypt your QuickBooks tokens on disk.\n' +
      `It must be at least ${MIN_PASSPHRASE_LENGTH} characters. If you forget it, just re-run \`auth --reset\`.\n`,
  );
  for (let tries = 0; tries < 3; tries++) {
    const first = await promptHidden('New passphrase: ');
    if (first.length < MIN_PASSPHRASE_LENGTH) {
      process.stderr.write(`Too short (minimum ${MIN_PASSPHRASE_LENGTH} characters).\n`);
      continue;
    }
    const second = await promptHidden('Repeat passphrase: ');
    if (first === second) return first;
    process.stderr.write('Passphrases did not match.\n');
  }
  throw new UserFacingError('No passphrase set.');
};
