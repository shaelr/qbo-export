import { sleep as realSleep } from '../util/retry.ts';

export interface ThrottleOptions {
  /** Max requests in flight. Intuit allows 10 per company; we stay well under. */
  maxConcurrent?: number;
  /** Max requests started per rolling window. Intuit allows ~500/min per company. */
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Caps both concurrency and request rate (sliding window) for one company. */
export class Throttle {
  readonly maxConcurrent: number;
  readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly started: number[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(options: ThrottleOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxPerWindow = options.maxPerWindow ?? 400;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.started.length > 0 && this.started[0]! <= now - this.windowMs) this.started.shift();
      if (this.active < this.maxConcurrent && this.started.length < this.maxPerWindow) {
        this.active++;
        this.started.push(now);
        return;
      }
      if (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      } else {
        await this.sleep(this.started[0]! + this.windowMs - now);
      }
    }
  }
}
