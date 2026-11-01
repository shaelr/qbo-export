import { describe, expect, it } from 'vitest';
import { buildCount, buildSelect, isQueryRejected } from '../src/api/query.ts';
import { Throttle } from '../src/api/throttle.ts';
import { QboApiError } from '../src/errors.ts';
import { ENTITIES, queryVariants, validateSince } from '../src/export/entities.ts';

describe('Throttle', () => {
  it('never exceeds the concurrency cap', async () => {
    const throttle = new Throttle({ maxConcurrent: 3, maxPerWindow: 1000 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        throttle.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it('spreads requests over the rolling window', async () => {
    let clock = 0;
    const starts: number[] = [];
    const throttle = new Throttle({
      maxConcurrent: 10,
      maxPerWindow: 5,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    for (let i = 0; i < 12; i++) await throttle.run(async () => void starts.push(clock));
    expect(starts).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000, 2000]);
  });

  it('defaults stay well under Intuit limits (10 concurrent, 500/min)', () => {
    const t = new Throttle();
    expect(t.maxConcurrent).toBeLessThanOrEqual(5);
    expect(t.maxPerWindow).toBeLessThan(500);
  });
});

describe('query building', () => {
  it('builds paginated selects and counts', () => {
    expect(buildSelect('Invoice', { where: [], orderBy: true }, 1001, 1000)).toBe('SELECT * FROM Invoice ORDERBY Id STARTPOSITION 1001 MAXRESULTS 1000');
    expect(buildSelect('Customer', { where: ['Active IN (true, false)', "MetaData.LastUpdatedTime >= '2025-01-01'"], orderBy: false }, 1, 50)).toBe(
      "SELECT * FROM Customer WHERE Active IN (true, false) AND MetaData.LastUpdatedTime >= '2025-01-01' STARTPOSITION 1 MAXRESULTS 50",
    );
    expect(buildCount('Vendor', ['Active IN (true, false)'])).toBe('SELECT COUNT(*) FROM Vendor WHERE Active IN (true, false)');
  });

  it('includes inactive records for every list entity with an Active flag', () => {
    for (const name of ['Customer', 'Vendor', 'Item', 'Account']) {
      const spec = ENTITIES.find((e) => e.name === name)!;
      expect(queryVariants(spec, null)[0]![0]!.where).toContain('Active IN (true, false)');
      // Last resort still covers inactive, via a separate Active = false query.
      expect(queryVariants(spec, null).at(-1)!.map((v) => v.where[0])).toEqual(['Active = true', 'Active = false']);
    }
  });

  it('applies --since only to entities that support it', () => {
    const invoice = ENTITIES.find((e) => e.name === 'Invoice')!;
    const taxCode = ENTITIES.find((e) => e.name === 'TaxCode')!;
    expect(queryVariants(invoice, '2025-01-01')[0]![0]!.where).toEqual(["MetaData.LastUpdatedTime >= '2025-01-01'"]);
    expect(queryVariants(taxCode, '2025-01-01')[0]![0]!.where).toEqual(['Active IN (true, false)']);
  });

  it('validates --since', () => {
    expect(validateSince('2025-01-01')).toBe('2025-01-01');
    expect(validateSince('2025-01-01T00:00:00-05:00')).toBe('2025-01-01T00:00:00-05:00');
    expect(() => validateSince("2025-01-01' OR 1=1")).toThrow(/--since/);
    expect(() => validateSince('2025-13-45')).toThrow(/--since/);
  });

  it('recognises query-text rejections but not other faults', () => {
    expect(isQueryRejected(new QboApiError(400, undefined, [{ code: '4000', message: 'Invalid query' }]))).toBe(true);
    expect(isQueryRejected(new QboApiError(400, undefined, [{ code: '6000', message: 'Feature not enabled' }]))).toBe(false);
    expect(isQueryRejected(new QboApiError(500, undefined, [{ code: '4000' }]))).toBe(false);
  });
});
