import type { TokenManager } from '../auth/token-manager.ts';
import { QboApiError, ReadOnlyViolationError, type QboFaultDetail } from '../errors.ts';
import type { Logger } from '../log.ts';
import { parseLossless } from '../util/lossless-json.ts';
import { DEFAULT_RETRY, parseRetryAfter, RetryableError, withRetry, type RetryOptions } from '../util/retry.ts';
import { Throttle } from './throttle.ts';

export interface QboClientOptions {
  baseUrl: string;
  realmId: string;
  minorVersion: string;
  tokens: TokenManager;
  log: Logger;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  throttle?: Throttle;
}

export interface QboResponse {
  /** Lossless parse: numbers are RawJSON holding their exact source text. */
  body: unknown;
  /** The exact response text, for writing untouched records. */
  text: string;
  intuitTid: string | undefined;
}

// This tool must never change anything in QuickBooks. Every company-API
// request funnels through request(), which refuses anything but GET.
const ALLOWED_METHODS = new Set(['GET']);

export function assertReadOnly(method: string): void {
  if (!ALLOWED_METHODS.has(method.toUpperCase())) {
    throw new ReadOnlyViolationError(`Refusing ${method} request: qbo-export is read-only.`);
  }
}

export class QboClient {
  private readonly opts: QboClientOptions;
  private readonly fetch: typeof fetch;
  private readonly throttle: Throttle;

  constructor(options: QboClientOptions) {
    this.opts = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.throttle = options.throttle ?? new Throttle();
  }

  get realmId(): string {
    return this.opts.realmId;
  }

  /** GET /v3/company/<realm>/<path>, with minorversion always appended. */
  get(path: string, params: Record<string, string> = {}): Promise<QboResponse> {
    const url = new URL(`${this.opts.baseUrl}/v3/company/${encodeURIComponent(this.opts.realmId)}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('minorversion', this.opts.minorVersion);
    return this.request('GET', url, path, 'application/json');
  }

  /** Like get(), for endpoints that answer in plain text (e.g. /download/<id> returns a URL). */
  async getText(path: string): Promise<string> {
    const url = new URL(`${this.opts.baseUrl}/v3/company/${encodeURIComponent(this.opts.realmId)}/${path}`);
    url.searchParams.set('minorversion', this.opts.minorVersion);
    return (await this.request('GET', url, path, 'text/plain')).text;
  }

  private request(method: string, url: URL, label: string, accept: string): Promise<QboResponse> {
    assertReadOnly(method);
    let refreshedAfter401 = false;
    return withRetry(
      async (attempt) => {
        const accessToken = await this.opts.tokens.getAccessToken();
        let res: Response;
        let text: string;
        try {
          // Only the HTTP exchange holds a throttle slot; backoff sleeps happen outside it.
          [res, text] = await this.throttle.run(async () => {
            const r = await this.fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}`, Accept: accept } });
            return [r, await r.text()] as const;
          });
        } catch (err) {
          throw new RetryableError(`Network error on ${label}`, undefined, { cause: err });
        }
        const intuitTid = res.headers.get('intuit_tid') ?? undefined;
        const log = { endpoint: label, status: res.status, intuitTid, attempt };

        if (res.status === 401 && !refreshedAfter401) {
          refreshedAfter401 = true;
          this.opts.log.info(log, 'Access token rejected; refreshing once');
          await this.opts.tokens.refreshAfterUnauthorized(accessToken);
          throw new RetryableError('401 after token refresh', 0);
        }
        if (res.status === 429 || res.status >= 500) {
          this.opts.log.warn(log, 'QuickBooks API throttled or unavailable; backing off');
          throw new RetryableError(`HTTP ${res.status} on ${label}`, parseRetryAfter(res.headers.get('retry-after')));
        }
        if (!res.ok) {
          const err = new QboApiError(res.status, intuitTid, extractFaults(text));
          this.opts.log.warn({ ...log, faults: err.faults.map((f) => f.code) }, 'QuickBooks API error');
          throw err;
        }
        this.opts.log.debug(log, 'QuickBooks API ok');
        return { body: accept === 'application/json' ? parseLossless(text) : text, text, intuitTid };
      },
      { ...DEFAULT_RETRY, ...this.opts.retry },
    );
  }
}

export function extractFaults(text: string): QboFaultDetail[] {
  try {
    const json = JSON.parse(text) as { Fault?: { Error?: Array<{ code?: string; Message?: string; Detail?: string }> } };
    return (json.Fault?.Error ?? []).map((e) => ({ code: e.code, message: e.Message, detail: e.Detail }));
  } catch {
    return [];
  }
}
