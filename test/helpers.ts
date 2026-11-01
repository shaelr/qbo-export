import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { KdfParams } from '../src/auth/crypto.ts';
import type { StoredTokens } from '../src/auth/token-store.ts';

/** Cheap scrypt parameters so tests run fast. Never use outside tests. */
export const TEST_KDF: KdfParams = { N: 1024, r: 8, p: 1 };

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qbo-export-test-'));
  dirs.push(dir);
  return dir;
}

export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = Response | ((req: RecordedRequest) => Response | Promise<Response>);

/** A fetch stand-in that replays queued responses and records every request. */
export function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responders];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req: RecordedRequest = {
      url: input.toString(),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body === undefined ? undefined : String(init.body),
    };
    requests.push(req);
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: unexpected request ${req.method} ${req.url}`);
    return typeof next === 'function' ? next(req) : next;
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const noSleep = { sleep: async () => {}, baseDelayMs: 1, maxDelayMs: 1 };

export function sampleTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    realmId: '9341453000000000',
    environment: 'sandbox',
    accessToken: 'AT-secret-access-1',
    accessTokenExpiresAt: '2026-10-31T13:00:00.000Z',
    refreshToken: 'RT-secret-refresh-1',
    refreshTokenExpiresAt: '2031-10-31T12:00:00.000Z',
    obtainedAt: '2026-10-31T12:00:00.000Z',
    ...overrides,
  };
}

/** A QboClient wired to `fetchFn`, with a valid stored token and no real sleeps. */
export async function makeClient(fetchFn: typeof fetch, realmId = '9341453000000000') {
  const { TokenStore } = await import('../src/auth/token-store.ts');
  const { OAuthClient } = await import('../src/auth/oauth.ts');
  const { TokenManager } = await import('../src/auth/token-manager.ts');
  const { QboClient } = await import('../src/api/client.ts');
  const { silentLogger } = await import('../src/log.ts');
  const store = new TokenStore(join(await tempDir(), 'tokens.enc.json'), async () => 'correct horse battery', TEST_KDF);
  await store.save(sampleTokens({ realmId, accessTokenExpiresAt: '2999-01-01T00:00:00.000Z' }));
  const oauth = new OAuthClient({ clientId: 'c', clientSecret: 's', redirectUri: 'http://localhost/cb', log: silentLogger, fetch: fakeFetch().fetch });
  const tokens = new TokenManager({ store, oauth, log: silentLogger });
  return new QboClient({
    baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
    realmId,
    minorVersion: '75',
    tokens,
    log: silentLogger,
    fetch: fetchFn,
    retry: { maxAttempts: 3, ...noSleep },
  });
}

export function fault(status: number, code: string, message: string, detail = ''): Response {
  return json(status, { Fault: { Error: [{ Message: message, Detail: detail, code }], type: 'ValidationFault' }, time: '2026-10-31T00:00:00Z' });
}

/**
 * Minimal stand-in for QBO's /query endpoint. `data` maps entity -> records as
 * raw JSON text (so money keeps its exact digits). Mimics QBO: inactive
 * records are hidden unless the query filters on Active; empty pages return
 * `"QueryResponse":{}`. `intercept` can return a Response to simulate faults.
 */
export function fakeQbo(data: Record<string, string[]>, intercept?: (query: string, n: number) => Response | undefined) {
  const queries: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('query') ?? '';
    queries.push(query);
    const override = intercept?.(query, queries.length);
    if (override) return override;

    const count = /^SELECT COUNT\(\*\) FROM (\w+)(?: WHERE (.*))?$/.exec(query);
    const select = /^SELECT \* FROM (\w+)(?: WHERE (.*?))?(?: ORDERBY Id)? STARTPOSITION (\d+) MAXRESULTS (\d+)$/.exec(query);
    const entity = (count ?? select)?.[1];
    if (!entity) return fault(400, '4000', 'Invalid query', `QueryParserError: ${query}`);
    const where = (count ?? select)![2] ?? '';
    const matching = (data[entity] ?? []).filter((text) => {
      const r = JSON.parse(text) as { Active?: boolean; MetaData?: { LastUpdatedTime?: string } };
      const active = r.Active !== false;
      if (/Active IN \(true, false\)/.test(where)) {
        // both
      } else if (/Active = false/.test(where)) {
        if (active) return false;
      } else if (!active) return false;
      const since = /MetaData\.LastUpdatedTime >= '([^']+)'/.exec(where)?.[1];
      return !since || (r.MetaData?.LastUpdatedTime ?? '') >= since;
    });
    // Real QBO omits totalCount for the CompanyInfo singleton (seen in the sandbox).
    if (count && entity === 'CompanyInfo') return json(200, '{"QueryResponse":{},"time":"2026-10-31T00:00:00Z"}');
    if (count) return json(200, `{"QueryResponse":{"totalCount":${matching.length}},"time":"2026-10-31T00:00:00Z"}`);
    const start = Number(select![3]);
    const max = Number(select![4]);
    const page = matching.slice(start - 1, start - 1 + max);
    const qr = page.length > 0 ? `{"${entity}":[${page.join(',')}],"startPosition":${start},"maxResults":${page.length}}` : '{}';
    return json(200, `{"QueryResponse":${qr},"time":"2026-10-31T00:00:00Z"}`);
  }) as typeof fetch;
  return { fetch: fetchFn, queries };
}
