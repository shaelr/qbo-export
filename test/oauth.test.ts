import { describe, expect, it } from 'vitest';
import { authorize, isLocalRedirect, parseCallback } from '../src/auth/authorize-flow.ts';
import { OAuthClient, toStoredTokens } from '../src/auth/oauth.ts';
import { ReauthorizeRequiredError, UserFacingError } from '../src/errors.ts';
import { silentLogger } from '../src/log.ts';
import { fakeFetch, json, noSleep } from './helpers.ts';

const tokenBody = {
  access_token: 'AT-new',
  refresh_token: 'RT-new',
  token_type: 'bearer',
  expires_in: 3600,
  x_refresh_token_expires_in: 8_726_400,
};

function client(fetchFn: typeof fetch, redirectUri = 'http://localhost:8765/callback') {
  return new OAuthClient({ clientId: 'cid', clientSecret: 'csecret', redirectUri, log: silentLogger, fetch: fetchFn, retry: { maxAttempts: 4, ...noSleep } });
}

describe('OAuthClient', () => {
  it('requests only the accounting scope', () => {
    const url = new URL(client(fakeFetch().fetch).authorizeUrl('st'));
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('refreshes with Basic auth and a form body', async () => {
    const f = fakeFetch(json(200, tokenBody));
    const res = await client(f.fetch).refresh('RT-old');
    expect(res.refresh_token).toBe('RT-new');
    const req = f.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(new URLSearchParams(req.body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(req.body).get('refresh_token')).toBe('RT-old');
  });

  it('maps invalid_grant to a re-authorize error', async () => {
    const f = fakeFetch(json(400, { error: 'invalid_grant' }));
    await expect(client(f.fetch).refresh('RT-revoked')).rejects.toBeInstanceOf(ReauthorizeRequiredError);
  });

  it('retries 429 and 5xx from the token endpoint', async () => {
    const f = fakeFetch(json(429, {}, { 'retry-after': '1' }), json(503, {}), json(200, tokenBody));
    expect((await client(f.fetch).refresh('RT')).access_token).toBe('AT-new');
    expect(f.requests).toHaveLength(3);
  });

  it('computes expiry timestamps from the token response', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const t = toStoredTokens(tokenBody, 'realm', 'sandbox', now);
    expect(t.accessTokenExpiresAt).toBe('2026-10-31T13:00:00.000Z');
    expect(t.refreshTokenExpiresAt).toBe(new Date(now + 8_726_400_000).toISOString());
  });
});

describe('authorization redirect handling', () => {
  it('extracts code and realmId when state matches', () => {
    expect(parseCallback('https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=AB1&state=s1&realmId=123', 's1')).toEqual({
      code: 'AB1',
      realmId: '123',
    });
  });

  it('rejects state mismatch, denial, and junk', () => {
    expect(() => parseCallback('http://localhost/cb?code=a&state=evil&realmId=1', 's1')).toThrow(/state mismatch/);
    expect(() => parseCallback('http://localhost/cb?error=access_denied&state=s1', 's1')).toThrow(/access_denied/);
    expect(() => parseCallback('not a url', 's1')).toThrow(UserFacingError);
    expect(() => parseCallback('http://localhost/cb?state=s1', 's1')).toThrow(/missing/);
  });

  it('chooses the local listener only for http://localhost redirect URIs', () => {
    expect(isLocalRedirect('http://localhost:8765/callback')).toBe(true);
    expect(isLocalRedirect('https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl')).toBe(false);
  });

  it('paste mode parses the pasted redirect URL', async () => {
    const oauth = client(fakeFetch().fetch, 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl');
    const result = await authorize({
      oauth,
      redirectUri: 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl',
      mode: 'auto',
      openBrowser: false,
      print: () => {},
      state: 'fixed',
      readLine: async () => 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=C9&state=fixed&realmId=4620816365',
    });
    expect(result).toEqual({ code: 'C9', realmId: '4620816365' });
  });

  it('local mode receives the browser redirect on the loopback listener', async () => {
    const redirectUri = 'http://localhost:18765/callback';
    const pending = authorize({ oauth: client(fakeFetch().fetch, redirectUri), redirectUri, mode: 'auto', openBrowser: false, print: () => {}, state: 'st8' });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch('http://127.0.0.1:18765/callback?code=LC&state=st8&realmId=77');
    expect(res.status).toBe(200);
    expect(await pending).toEqual({ code: 'LC', realmId: '77' });
  });
});
