import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReadOnly, QboClient } from '../src/api/client.ts';
import { OAuthClient } from '../src/auth/oauth.ts';
import { TokenManager } from '../src/auth/token-manager.ts';
import { TokenStore } from '../src/auth/token-store.ts';
import { QboApiError, ReadOnlyViolationError } from '../src/errors.ts';
import { silentLogger } from '../src/log.ts';
import { numberText } from '../src/util/lossless-json.ts';
import { fakeFetch, fixture, json, noSleep, sampleTokens, TEST_KDF, tempDir } from './helpers.ts';

const NOW = Date.parse('2026-10-31T12:30:00Z');

async function setup(apiResponses: Response[], oauthResponses: Response[] = []) {
  const store = new TokenStore(join(await tempDir(), 'tokens.enc.json'), async () => 'correct horse battery', TEST_KDF);
  await store.save(sampleTokens({ accessTokenExpiresAt: '2026-10-31T13:30:00.000Z' }));
  const oauthFetch = fakeFetch(...oauthResponses);
  const oauth = new OAuthClient({ clientId: 'c', clientSecret: 's', redirectUri: 'http://localhost/cb', log: silentLogger, fetch: oauthFetch.fetch });
  const tokens = new TokenManager({ store, oauth, log: silentLogger, now: () => NOW });
  const api = fakeFetch(...apiResponses);
  const client = new QboClient({
    baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
    realmId: '9341453000000000',
    minorVersion: '75',
    tokens,
    log: silentLogger,
    fetch: api.fetch,
    retry: { maxAttempts: 4, ...noSleep },
  });
  return { client, api: api.requests, oauth: oauthFetch.requests };
}

describe('QboClient', () => {
  it('GETs the company endpoint with minorversion and a bearer token', async () => {
    const { client, api } = await setup([json(200, await fixture('sandbox/companyinfo.json'), { intuit_tid: 'tid-1' })]);
    const res = await client.get('companyinfo/9341453000000000');
    expect((res.body as any).CompanyInfo.Country).toBe('CA');
    expect(res.intuitTid).toBe('tid-1');
    const url = new URL(api[0]!.url);
    expect(url.origin + url.pathname).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company/9341453000000000/companyinfo/9341453000000000');
    expect(url.searchParams.get('minorversion')).toBe('75');
    expect(api[0]!.method).toBe('GET');
    expect(api[0]!.headers.authorization).toBe('Bearer AT-secret-access-1');
  });

  it('returns money values losslessly', async () => {
    const { client } = await setup([json(200, await fixture('sandbox/invoice-money.json'))]);
    const res = await client.get('query', { query: 'select * from Invoice' });
    expect(numberText((res.body as any).QueryResponse.Invoice[0].TotalAmt)).toBe('1130.10');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const { client, api, oauth } = await setup(
      [json(401, await fixture('sandbox/fault-401.json')), json(200, await fixture('sandbox/companyinfo.json'))],
      [json(200, { access_token: 'AT-2', refresh_token: 'RT-2', token_type: 'bearer', expires_in: 3600 })],
    );
    await client.get('companyinfo/1');
    expect(oauth).toHaveLength(1);
    expect(api[1]!.headers.authorization).toBe('Bearer AT-2');
  });

  it('backs off on 429/5xx and surfaces other faults with details', async () => {
    const ok = await setup([json(429, '', { 'retry-after': '1' }), json(502, ''), json(200, '{}')]);
    await ok.client.get('companyinfo/1');
    expect(ok.api).toHaveLength(3);

    const bad = await setup([json(400, await fixture('sandbox/fault-400-validation.json'), { intuit_tid: 'tid-9' })]);
    const err = await bad.client.get('query', { query: 'select' }).catch((e) => e);
    expect(err).toBeInstanceOf(QboApiError);
    expect(err.status).toBe(400);
    expect(err.faults[0].code).toBe('4000');
    expect(err.message).toContain('tid-9');
  });
});

describe('read-only guard', () => {
  it('allows GET and refuses every mutating method', () => {
    expect(() => assertReadOnly('GET')).not.toThrow();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(() => assertReadOnly(m)).toThrow(ReadOnlyViolationError);
    }
  });
});
