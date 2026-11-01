import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { UserFacingError } from '../errors.ts';
import type { OAuthClient } from './oauth.ts';

export interface AuthorizationResult {
  code: string;
  realmId: string;
}

export type AuthorizeMode = 'auto' | 'local' | 'paste';

export interface AuthorizeOptions {
  oauth: OAuthClient;
  redirectUri: string;
  mode: AuthorizeMode;
  openBrowser: boolean;
  /** Where user instructions are printed. */
  print: (line: string) => void;
  /** Reads the pasted redirect URL (paste mode). */
  readLine?: (question: string) => Promise<string>;
  timeoutMs?: number;
  state?: string;
}

/** Validates the redirect Intuit sent the browser to and extracts code + realmId. */
export function parseCallback(redirected: string, expectedState: string): AuthorizationResult {
  let url: URL;
  try {
    url = new URL(redirected.trim());
  } catch {
    throw new UserFacingError('That does not look like a URL. Paste the full address from the browser bar.');
  }
  const p = url.searchParams;
  const error = p.get('error');
  if (error) throw new UserFacingError(`Authorization was not granted (${error}).`);
  if (p.get('state') !== expectedState) {
    throw new UserFacingError('The authorization response did not match this request (state mismatch). Start `auth` again.');
  }
  const code = p.get('code');
  const realmId = p.get('realmId');
  if (!code || !realmId) throw new UserFacingError('The redirect URL is missing the code or realmId parameter.');
  return { code, realmId };
}

export function isLocalRedirect(redirectUri: string): boolean {
  const url = new URL(redirectUri);
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export async function authorize(options: AuthorizeOptions): Promise<AuthorizationResult> {
  const state = options.state ?? randomBytes(24).toString('base64url');
  const authUrl = options.oauth.authorizeUrl(state);
  const local = options.mode === 'local' || (options.mode === 'auto' && isLocalRedirect(options.redirectUri));
  if (local && !isLocalRedirect(options.redirectUri)) {
    throw new UserFacingError(`--local needs an http://localhost redirect URI; configured is ${options.redirectUri}.`);
  }

  if (local) {
    const pending = listenForCallback(options.redirectUri, state, options.timeoutMs ?? 5 * 60_000);
    options.print('Opening the QuickBooks consent page. If no browser opens, visit:');
    options.print(`  ${authUrl}`);
    if (options.openBrowser) openInBrowser(authUrl);
    return pending;
  }

  options.print('1. Open this URL, sign in, and choose the company to export:');
  options.print(`  ${authUrl}`);
  options.print('2. After you click Connect you will land on an Intuit page. Copy the FULL URL from the');
  options.print('   address bar (it contains ?code=...&realmId=...) and paste it below.');
  if (options.openBrowser) openInBrowser(authUrl);
  const readLine = options.readLine ?? readLineFromTerminal;
  return parseCallback(await readLine('Redirect URL: '), state);
}

function listenForCallback(redirectUri: string, state: string, timeoutMs: number): Promise<AuthorizationResult> {
  const target = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end();
        return;
      }
      try {
        const result = parseCallback(url.toString(), state);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<p>QuickBooks connected. You can close this tab and return to the terminal.</p>');
        finish(() => resolve(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end((err as Error).message);
        finish(() => reject(err));
      }
    });
    const timer = setTimeout(
      () => finish(() => reject(new UserFacingError('Timed out waiting for the QuickBooks authorization redirect.'))),
      timeoutMs,
    );
    function finish(settle: () => void): void {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      settle();
    }
    server.on('error', (err) => finish(() => reject(err)));
    server.listen(Number(target.port || 80), target.hostname === 'localhost' ? '127.0.0.1' : target.hostname);
  });
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The URL is printed too, so failing to launch a browser is harmless.
  }
}

async function readLineFromTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
