import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './errors.ts';

export type QboEnvironment = 'sandbox' | 'production';

export const TOOL_VERSION = '0.1.0';
export const DEFAULT_MINOR_VERSION = '75';

// The only scope this tool ever requests. No payments, payroll or OpenID scopes.
export const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

export const OAUTH_ENDPOINTS = {
  authorize: 'https://appcenter.intuit.com/connect/oauth2',
  token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
} as const;

export const API_BASE_URLS: Record<QboEnvironment, string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

// Production redirect URIs must be HTTPS and not localhost, so for production
// we register Intuit's own Playground redirect page and the user pastes the
// final URL (which carries ?code=&realmId=&state=) back into the CLI.
export const PLAYGROUND_REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';
export const DEFAULT_SANDBOX_REDIRECT_URI = 'http://localhost:8765/callback';

export interface Config {
  environment: QboEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minorVersion: string;
  apiBaseUrl: string;
  stateDir: string;
  tokenFile: string;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

/** Reads NAME from the environment, or the contents of the file named by NAME_FILE. */
export function readSecret(env: Env, name: string): string {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      throw new ConfigError(`Could not read ${name}_FILE (${file}).`);
    }
  }
  throw new ConfigError(`Missing ${name}. Set it in .env or point ${name}_FILE at a file containing it.`);
}

function defaultStateDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'qbo-export');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'qbo-export');
}

export function loadConfig(env: Env = process.env): Config {
  const rawEnv = (env.QBO_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  if (rawEnv !== 'sandbox' && rawEnv !== 'production') {
    throw new ConfigError(`QBO_ENVIRONMENT must be "sandbox" or "production" (got "${rawEnv}").`);
  }
  const environment: QboEnvironment = rawEnv;
  const stateDir = env.QBO_STATE_DIR?.trim() || defaultStateDir();
  const redirectUri =
    env.QBO_REDIRECT_URI?.trim() ||
    (environment === 'production' ? PLAYGROUND_REDIRECT_URI : DEFAULT_SANDBOX_REDIRECT_URI);
  const minorVersion = env.QBO_MINOR_VERSION?.trim() || DEFAULT_MINOR_VERSION;
  if (!/^\d+$/.test(minorVersion)) throw new ConfigError('QBO_MINOR_VERSION must be a number.');

  return {
    environment,
    clientId: readSecret(env, 'QBO_CLIENT_ID'),
    clientSecret: readSecret(env, 'QBO_CLIENT_SECRET'),
    redirectUri,
    minorVersion,
    apiBaseUrl: API_BASE_URLS[environment],
    stateDir,
    tokenFile: join(stateDir, `tokens-${environment}.enc.json`),
    logLevel: env.QBO_LOG_LEVEL?.trim() || 'warn',
  };
}
