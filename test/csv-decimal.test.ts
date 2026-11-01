import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initArchive } from '../src/archive/layout.ts';
import { csvCell, invoiceStatus, writeCsvs } from '../src/export/csv.ts';
import { addDecimal, cmpDecimal, fromUnits, subDecimal, toUnits } from '../src/util/decimal.ts';
import { parseLossless } from '../src/util/lossless-json.ts';
import { tempDir } from './helpers.ts';

describe('decimal', () => {
  it('adds money exactly (no float drift)', () => {
    expect(addDecimal('0.10', '0.20')).toBe('0.30');
    expect(addDecimal('1130.10', '-130.10', '0.005')).toBe('1000.005');
    expect(subDecimal('100', '100.00')).toBe('0.00');
    expect(cmpDecimal('10.0', '9.99')).toBe(1);
    expect(fromUnits(toUnits('-0.5'))).toBe('-0.50');
    expect(() => toUnits('1e5')).toThrow();
  });
});

describe('csv', () => {
  it('quotes and neutralises formula-like text but not negative numbers', () => {
    expect(csvCell('Smith, Jones "&" Co')).toBe('"Smith, Jones ""&"" Co"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-120.50', 'number')).toBe('-120.50');
    expect(csvCell('-120.50')).toBe('-120.50');
    expect(csvCell('-cmd')).toBe("'-cmd");
  });

  it('derives invoice status', () => {
    const s = (json: string) => invoiceStatus(parseLossless(json));
    expect(s('{"TotalAmt":100.00,"Balance":0}')).toBe('Paid');
    expect(s('{"TotalAmt":100.00,"Balance":100.0}')).toBe('Open');
    expect(s('{"TotalAmt":100.00,"Balance":40.00}')).toBe('Partially paid');
    expect(s('{"TotalAmt":0,"Balance":0,"PrivateNote":"Voided"}')).toBe('Voided');
  });

  it('writes one expense row per line across Purchase, Bill and VendorCredit, with exact amounts', async () => {
    const paths = await initArchive(join(await tempDir(), 'a'));
    const put = async (entity: string, id: string, body: string) => {
      await mkdir(join(paths.raw, entity), { recursive: true });
      await writeFile(join(paths.raw, entity, `${id}.json`), body);
    };
    await put(
      'Purchase',
      '7',
      '{"Id":"7","TxnDate":"2024-02-01","PaymentType":"CreditCard","EntityRef":{"value":"3","name":"Staples","type":"Vendor"},"AccountRef":{"name":"Visa"},"TotalAmt":113.00,"TxnTaxDetail":{"TotalTax":13.00},"Line":[{"Id":"1","Amount":60.00,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"name":"Office supplies"},"TaxCodeRef":{"value":"5"}}},{"Id":"2","Amount":40.00,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"name":"Postage"}}}]}',
    );
    await put('Bill', '9', '{"Id":"9","TxnDate":"2024-01-10","VendorRef":{"value":"4","name":"Hydro One"},"APAccountRef":{"name":"Accounts Payable"},"TotalAmt":56.50,"Balance":56.50,"Line":[{"Amount":50.00,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"name":"Utilities"}}}]}');
    await put('VendorCredit', '11', '{"Id":"11","TxnDate":"2024-03-01","VendorRef":{"name":"Staples"},"TotalAmt":10.00,"Line":[]}');

    await writeCsvs(paths);
    const csv = await readFile(join(paths.csv, 'expenses.csv'), 'utf8');
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(rows).toHaveLength(5); // header + 2 purchase lines + 1 bill line + 1 credit with no lines
    expect(rows[1]).toMatch(/^Bill,9,/);
    expect(rows[2]).toContain('Office supplies');
    expect(rows[2]).toContain('113.00');
    expect(rows[3]).toContain('Postage');
    expect(rows[4]).toMatch(/^VendorCredit,11,/);
  });
});
