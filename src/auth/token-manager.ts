import { ReauthorizeRequiredError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { acquireLock } from '../util/lockfile.ts';
import { toStoredTokens, type OAuthClient } from './oauth.ts';
import type { StoredTokens, TokenStore } from './token-store.ts';

export interface TokenManagerOptions {
  store: TokenStore;
  oauth: OAuthClient;
  log: Logger;
  now?: () => number;
  /** Refresh this long before the access token actually expires. */
  skewMs?: number;
  /** Lock file guarding refresh across processes; defaults to `<token file>.lock`. */
  lockPath?: string;
}

/**
 * Hands out valid access tokens, refreshing when needed.
 *
 * Intuit rotates refresh tokens: once a refresh returns a new one, the old one
 * stops working. So the order is always: refresh, persist the new pair to
 * disk, and only then use the new access token. If persisting fails the new
 * token is never handed out and the error propagates.
 *
 * Refreshes are single-flight within the process and serialized across
 * processes by a lock file; after taking the lock we re-read the store in case
 * another process already refreshed.
 */
export class TokenManager {
  private readonly opts: TokenManagerOptions;
  private readonly now: () => number;
  private readonly skewMs: number;
  private current: StoredTokens | undefined;
  private inflight: Promise<StoredTokens> | undefined;

  constructor(options: TokenManagerOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.skewMs = options.skewMs ?? 5 * 60_000;
  }

  async realmId(): Promise<string> {
    return (await this.tokens()).realmId;
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.tokens();
    if (this.isFresh(tokens)) return tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Called after the API rejects `rejectedAccessToken` with 401. If someone
   * already replaced it, use the replacement; otherwise force a refresh.
   */
  async refreshAfterUnauthorized(rejectedAccessToken: string): Promise<string> {
    const tokens = await this.tokens();
    if (tokens.accessToken !== rejectedAccessToken && this.isFresh(tokens)) return tokens.accessToken;
    return (await this.refresh(rejectedAccessToken)).accessToken;
  }

  private async tokens(): Promise<StoredTokens> {
    this.current ??= await this.opts.store.load();
    return this.current;
  }

  private isFresh(tokens: StoredTokens): boolean {
    return Date.parse(tokens.accessTokenExpiresAt) - this.skewMs > this.now();
  }

  private refresh(rejectedAccessToken?: string): Promise<StoredTokens> {
    this.inflight ??= this.doRefresh(rejectedAccessToken).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doRefresh(rejectedAccessToken: string | undefined): Promise<StoredTokens> {
    const release = await acquireLock(this.opts.lockPath ?? `${this.opts.store.path}.lock`);
    try {
      // Another process may have refreshed while we waited for the lock.
      const onDisk = await this.opts.store.load();
      if (this.isFresh(onDisk) && onDisk.accessToken !== rejectedAccessToken) {
        this.current = onDisk;
        return onDisk;
      }
      if (onDisk.refreshTokenExpiresAt && Date.parse(onDisk.refreshTokenExpiresAt) <= this.now()) {
        throw new ReauthorizeRequiredError('refresh token expired');
      }

      this.opts.log.info('Refreshing QuickBooks access token');
      const res = await this.opts.oauth.refresh(onDisk.refreshToken);
      const next = toStoredTokens(res, onDisk.realmId, onDisk.environment, this.now());
      await this.opts.store.save(next); // persist BEFORE the new token is used anywhere
      this.current = next;
      this.opts.log.info({ refreshTokenRotated: res.refresh_token !== onDisk.refreshToken }, 'Access token refreshed and persisted');
      return next;
    } finally {
      await release();
    }
  }
}
