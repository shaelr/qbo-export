export class RetryableError extends Error {
  override name = 'RetryableError';
  /** Server-requested wait (from Retry-After), which overrides computed backoff. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: RetryableError }) => void;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 60_000 };

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with "equal jitter": half fixed, half random. `attempt` is 1-based. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Runs `fn`, retrying only when it throws RetryableError, up to maxAttempts total attempts. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= options.maxAttempts) throw err;
      const delayMs = Math.min(
        options.maxDelayMs,
        err.retryAfterMs ?? backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random),
      );
      options.onRetry?.({ attempt, delayMs, error: err });
      await wait(delayMs);
    }
  }
}
