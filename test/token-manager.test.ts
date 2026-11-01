import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OAuthClient } from '../src/auth/oauth.ts';
import { TokenManager } from '../src/auth/token-manager.ts';
import { TokenStore } from '../src/auth/token-store.ts';
import { ReauthorizeRequiredError, TokenPersistError } from '../src/errors.ts';
import { silentLogger } from '../src/log.ts';
import { fakeFetch, json, noSleep, sampleTokens, TEST_KDF, tempDir } from './helpers.ts';

const NOW = Date.parse('2026-10-31T12:30:00Z');

async function setup(responses: Response[], tokenOverrides = {}) {
  const dir = await tempDir();
  const store = new TokenStore(join(dir, 'tokens.enc.json'), async () => 'correct horse battery', TEST_KDF);
  await store.save(sampleTokens(tokenOverrides));
  const f = fakeFetch(...responses);
  const oauth = new OAuthClient({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost/cb', log: silentLogger, fetch: f.fetch, retry: { maxAttempts: 2, ...noSleep } });
  const manager = new TokenManager({ store, oauth, log: silentLogger, now: () => NOW });
  return { store, manager, requests: f.requests, dir };
}

const rotated = (n: number) => json(200, { access_token: `AT-${n}`, refresh_token: `RT-${n}`, token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8_726_400 });

describe('TokenManager', () => {
  it('uses a still-valid access token without refreshing', async () => {
    const { manager, requests } = await setup([], { accessTokenExpiresAt: '2026-10-31T13:30:00.000Z' });
    expect(await manager.getAccessToken()).toBe('AT-secret-access-1');
    expect(requests).toHaveLength(0);
  });

  it('refreshes near expiry and persists the rotated refresh token BEFORE returning the new access token', async () => {
    // Expires 12:31; with the 5-minute skew it is already due at 12:30.
    const { store, manager } = await setup([rotated(2)], { accessTokenExpiresAt: '2026-10-31T12:31:00.000Z' });
    const events: string[] = [];
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (t) => {
      events.push(`save:${t.refreshToken}`);
      await realSave(t);
    });
    const token = await manager.getAccessToken();
    events.push(`use:${token}`);
    expect(events).toEqual(['save:RT-2', 'use:AT-2']);

    // A brand-new process reading the store sees the rotated token.
    const reread = new TokenStore(store.path, async () => 'correct horse battery', TEST_KDF);
    expect((await reread.load()).refreshToken).toBe('RT-2');
  });

  it('never hands out a new access token if persisting it fails', async () => {
    const { store, manager } = await setup([rotated(2)], { accessTokenExpiresAt: '2026-10-31T12:00:00.000Z' });
    vi.spyOn(store, 'save').mockRejectedValue(new TokenPersistError('disk full'));
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(TokenPersistError);
  });

  it('collapses concurrent refreshes into a single token request', async () => {
    const { manager, requests } = await setup([rotated(2)], { accessTokenExpiresAt: '2026-10-31T12:00:00.000Z' });
    const tokens = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);
    expect(tokens).toEqual(['AT-2', 'AT-2', 'AT-2']);
    expect(requests).toHaveLength(1);
  });

  it('picks up a refresh done by another process instead of refreshing again', async () => {
    const { store, manager, requests } = await setup([], { accessTokenExpiresAt: '2026-10-31T12:00:00.000Z' });
    await manager.realmId(); // load the stale copy into memory
    const other = new TokenStore(store.path, async () => 'correct horse battery', TEST_KDF);
    await other.save(sampleTokens({ accessToken: 'AT-other', refreshToken: 'RT-other', accessTokenExpiresAt: '2026-10-31T13:30:00.000Z', obtainedAt: '2026-10-31T12:29:00.000Z' }));
    expect(await manager.getAccessToken()).toBe('AT-other');
    expect(requests).toHaveLength(0);
  });

  it('forces a refresh after a 401 even if the token looks unexpired', async () => {
    const { manager, requests } = await setup([rotated(3)], { accessTokenExpiresAt: '2026-10-31T13:30:00.000Z' });
    expect(await manager.refreshAfterUnauthorized('AT-secret-access-1')).toBe('AT-3');
    expect(requests).toHaveLength(1);
  });

  it('asks for re-authorization when the refresh token is revoked or expired', async () => {
    const revoked = await setup([json(400, { error: 'invalid_grant' })], { accessTokenExpiresAt: '2026-10-31T12:00:00.000Z' });
    await expect(revoked.manager.getAccessToken()).rejects.toBeInstanceOf(ReauthorizeRequiredError);

    const expired = await setup([], { accessTokenExpiresAt: '2026-10-31T12:00:00.000Z', refreshTokenExpiresAt: '2026-10-30T00:00:00.000Z' });
    await expect(expired.manager.getAccessToken()).rejects.toThrow(/refresh token expired/);
    expect(expired.requests).toHaveLength(0);
  });
});
