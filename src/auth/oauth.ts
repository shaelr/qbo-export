import { ACCOUNTING_SCOPE, OAUTH_ENDPOINTS, type QboEnvironment } from '../config.ts';
import { ReauthorizeRequiredError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { DEFAULT_RETRY, parseRetryAfter, RetryableError, withRetry, type RetryOptions } from '../util/retry.ts';
import type { StoredTokens } from './token-store.ts';

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** Seconds until the access token expires (normally 3600). */
  expires_in: number;
  /** Seconds until the refresh token expires. */
  x_refresh_token_expires_in?: number;
}

export interface OAuthClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  log: Logger;
  fetch?: typeof fetch;
  tokenUrl?: string;
  retry?: RetryOptions;
}

/** Talks only to Intuit's OAuth endpoints, never to the company API. */
export class OAuthClient {
  private readonly opts: OAuthClientOptions;
  private readonly fetch: typeof fetch;

  constructor(options: OAuthClientOptions) {
    this.opts = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  authorizeUrl(state: string): string {
    const url = new URL(OAUTH_ENDPOINTS.authorize);
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', ACCOUNTING_SCOPE);
    url.searchParams.set('redirect_uri', this.opts.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<TokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.opts.redirectUri }),
      'code exchange',
    );
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), 'token refresh');
  }

  private tokenRequest(body: URLSearchParams, purpose: string): Promise<TokenResponse> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    return withRetry(
      async () => {
        let res: Response;
        try {
          res = await this.fetch(this.opts.tokenUrl ?? OAUTH_ENDPOINTS.token, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basic}`,
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          });
        } catch (err) {
          throw new RetryableError(`Network error during ${purpose}`, undefined, { cause: err });
        }
        const intuitTid = res.headers.get('intuit_tid') ?? undefined;
        if (res.status === 429 || res.status >= 500) {
          this.opts.log.warn({ status: res.status, intuitTid, purpose }, 'OAuth endpoint busy; retrying');
          throw new RetryableError(`HTTP ${res.status} during ${purpose}`, parseRetryAfter(res.headers.get('retry-after')));
        }
        const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
        if (!res.ok) {
          this.opts.log.warn({ status: res.status, intuitTid, purpose, error: json.error }, 'OAuth request rejected');
          if (json.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
            throw new ReauthorizeRequiredError(json.error ?? `HTTP ${res.status}`);
          }
          throw new Error(`OAuth ${purpose} failed with HTTP ${res.status}${json.error ? ` (${json.error})` : ''}`);
        }
        if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
          throw new Error(`OAuth ${purpose} returned an incomplete token response.`);
        }
        this.opts.log.info({ intuitTid, purpose }, 'OAuth tokens issued');
        return json as TokenResponse;
      },
      { ...DEFAULT_RETRY, maxAttempts: 4, ...this.opts.retry },
    );
  }
}

export function toStoredTokens(res: TokenResponse, realmId: string, environment: QboEnvironment, now: number): StoredTokens {
  return {
    realmId,
    environment,
    accessToken: res.access_token,
    accessTokenExpiresAt: new Date(now + res.expires_in * 1000).toISOString(),
    refreshToken: res.refresh_token,
    refreshTokenExpiresAt:
      typeof res.x_refresh_token_expires_in === 'number'
        ? new Date(now + res.x_refresh_token_expires_in * 1000).toISOString()
        : null,
    obtainedAt: new Date(now).toISOString(),
  };
}
