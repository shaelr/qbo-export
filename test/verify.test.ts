import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initArchive, type ArchivePaths, type Manifest } from '../src/archive/layout.ts';
import { ENTITIES } from '../src/export/entities.ts';
import { silentLogger } from '../src/log.ts';
import { fiscalYears } from '../src/report/archive-totals.ts';
import { parseCdc } from '../src/report/cdc.ts';
import { parseAgedReceivablesTotal, parsePnl, parsePnlDetailTxns } from '../src/report/reports-api.ts';
import { buildVerification, compare, fmtMoney, renderMarkdown, writeVerification } from '../src/report/verify.ts';
import { parseLossless } from '../src/util/lossless-json.ts';
import { fault, fixture, json, makeClient, tempDir } from './helpers.ts';

const NOW = new Date('2026-10-31T17:00:00Z');

async function put(paths: ArchivePaths, entity: string, id: string, body: string) {
  await mkdir(join(paths.raw, entity), { recursive: true });
  await writeFile(join(paths.raw, entity, `${id}.json`), body);
}

/** A small Canadian company: HST at 13%, one asset purchase, a depreciation JE, interest deposited. */
async function seedArchive(paths: ArchivePaths) {
  await put(paths, 'CompanyInfo', '1', '{"Id":"1","CompanyName":"Maple Test Co","Country":"CA","FiscalYearStartMonth":"January"}');
  await put(paths, 'Preferences', 'Preferences', '{"ReportPrefs":{"ReportBasis":"Accrual"}}');
  const acct = (id: string, name: string, cls: string) => put(paths, 'Account', id, `{"Id":"${id}","Name":"${name}","Classification":"${cls}"}`);
  await acct('1', 'Services', 'Revenue');
  await acct('2', 'Office', 'Expense');
  await acct('3', 'Equipment', 'Asset');
  await acct('4', 'Interest income', 'Revenue');
  await acct('5', 'Depreciation', 'Expense');

  await put(paths, 'Invoice', '130', '{"Id":"130","TxnDate":"2024-03-01","TotalAmt":1130.00,"TxnTaxDetail":{"TotalTax":130.00},"Balance":0}');
  await put(paths, 'Invoice', '131', '{"Id":"131","TxnDate":"2024-04-01","TotalAmt":565.00,"TxnTaxDetail":{"TotalTax":65.00},"Balance":565.00}');
  await put(paths, 'Invoice', '132', '{"Id":"132","TxnDate":"2025-02-01","TotalAmt":226.00,"TxnTaxDetail":{"TotalTax":26.00},"Balance":0}');
  await put(paths, 'CreditMemo', '140', '{"Id":"140","TxnDate":"2024-05-01","TotalAmt":113.00,"TxnTaxDetail":{"TotalTax":13.00},"RemainingCredit":50.00}');
  await put(paths, 'Payment', '150', '{"Id":"150","TxnDate":"2024-05-02","TotalAmt":25.00,"UnappliedAmt":25.00}');

  const line = (amt: string, acctId: string) => `{"Amount":${amt},"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"value":"${acctId}"}}}`;
  await put(paths, 'Purchase', '107', `{"Id":"107","TxnDate":"2024-02-01","TotalAmt":113.00,"TxnTaxDetail":{"TotalTax":13.00},"Line":[${line('100.00', '2')}]}`);
  await put(paths, 'Purchase', '108', `{"Id":"108","TxnDate":"2024-02-03","TotalAmt":2000.00,"Line":[${line('2000.00', '3')}]}`);
  await put(paths, 'Purchase', '109', `{"Id":"109","TxnDate":"2024-02-05","Credit":true,"TotalAmt":20.00,"Line":[${line('20.00', '2')}]}`);
  await put(paths, 'Bill', '90', `{"Id":"90","TxnDate":"2024-02-10","TotalAmt":50.00,"Balance":0,"Line":[${line('50.00', '2')}]}`);
  await put(paths, 'VendorCredit', '91', `{"Id":"91","TxnDate":"2024-02-11","TotalAmt":10.00,"Line":[${line('10.00', '2')}]}`);
  await put(
    paths,
    'JournalEntry',
    '200',
    '{"Id":"200","TxnDate":"2024-12-31","Line":[{"Amount":300.00,"DetailType":"JournalEntryLineDetail","JournalEntryLineDetail":{"PostingType":"Debit","AccountRef":{"value":"5"}}},{"Amount":300.00,"DetailType":"JournalEntryLineDetail","JournalEntryLineDetail":{"PostingType":"Credit","AccountRef":{"value":"3"}}}]}',
  );
  await put(
    paths,
    'Deposit',
    '300',
    '{"Id":"300","TxnDate":"2024-08-01","TotalAmt":1142.34,"Line":[{"Amount":1130.00,"LinkedTxn":[{"TxnId":"150","TxnType":"Payment"}]},{"Amount":12.34,"DetailType":"DepositLineDetail","DepositLineDetail":{"AccountRef":{"value":"4"}}}]}',
  );
  await put(paths, 'Customer', '5', '{"Id":"5","DisplayName":"Old customer"}'); // deleted later, but archived
}

function manifestFor(overrides: Partial<Manifest> = {}): Manifest {
  const entities: Manifest['entities'] = {};
  for (const e of ENTITIES) entities[e.name] = { fetched: 1, qboCount: 1, filesInArchive: 1, notReturnedByQbo: [], status: 'complete' };
  entities.Class = { fetched: 0, qboCount: null, filesInArchive: 0, notReturnedByQbo: [], status: 'skipped', note: 'Not available on Essentials' };
  entities.Invoice = { fetched: 3, qboCount: 3, filesInArchive: 3, notReturnedByQbo: ['44'], status: 'complete' };
  return {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    environment: 'sandbox',
    realmId: '9341453000000000',
    companyName: 'Maple Test Co',
    minorVersion: '75',
    exportStartedAt: NOW.toISOString(),
    exportFinishedAt: NOW.toISOString(),
    since: null,
    firstExportStartedAt: '2026-09-01T00:00:00Z',
    entities,
    attachmentSummary: { found: 2, withFile: 2, noteOnly: 0, downloaded: 1, alreadyVerified: 0, failed: 0, sizeMismatches: 0, unlinked: 1, skippedUnlinked: 1, totalBytes: 14 },
    attachments: [],
    ...overrides,
  };
}

/** Routes Reports API and CDC calls to fixtures. */
async function reportsApi(options: { cdc?: (entities: string) => Response } = {}) {
  const calls: string[] = [];
  const fx = {
    pnl2024: await fixture('sandbox/pnl-2024.json'),
    pnl2025: await fixture('sandbox/pnl-2025.json'),
    pnlEmpty: await fixture('sandbox/pnl-empty.json'),
    detail2024: await fixture('sandbox/pnl-detail-2024.json'),
    ar: await fixture('sandbox/aged-receivables.json'),
    cdc: await fixture('sandbox/cdc.json'),
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    calls.push(`${path}?${url.searchParams.toString()}`);
    const start = url.searchParams.get('start_date');
    if (path === 'reports/ProfitAndLoss') return json(200, start === '2024-01-01' ? fx.pnl2024 : start === '2025-01-01' ? fx.pnl2025 : fx.pnlEmpty);
    if (path === 'reports/ProfitAndLossDetail') return json(200, start === '2024-01-01' ? fx.detail2024 : fx.pnlEmpty);
    if (path === 'reports/AgedReceivables') return json(200, fx.ar);
    if (path === 'cdc') return options.cdc ? options.cdc(url.searchParams.get('entities') ?? '') : json(200, fx.cdc);
    return fault(400, '4000', 'unexpected', path);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

async function verify(manifest = manifestFor(), api?: Awaited<ReturnType<typeof reportsApi>>) {
  const paths = await initArchive(join(await tempDir(), 'archive'));
  await seedArchive(paths);
  const qbo = api ?? (await reportsApi());
  const client = await makeClient(qbo.fetch);
  const report = await buildVerification(paths, { client, log: silentLogger, manifest, allEntities: ENTITIES.map((e) => e.name), now: () => NOW });
  return { report, paths, calls: qbo.calls };
}

describe('report parsing', () => {
  it('reads P&L section totals as exact strings', async () => {
    const pnl = parsePnl(parseLossless(await fixture('sandbox/pnl-2024.json')) as any);
    expect(pnl).toMatchObject({ income: '1400.00', otherIncome: '12.34', totalIncome: '1412.34', expenses: '420.00', cogs: '0', totalExpenses: '420.00', netIncome: '992.34', basis: 'Accrual' });
    expect(parsePnl(parseLossless(await fixture('sandbox/pnl-empty.json')) as any).totalIncome).toBe('0.00');
  });

  it('lists P&L Detail transactions with their ids, at any nesting depth', async () => {
    const txns = parsePnlDetailTxns(parseLossless(await fixture('sandbox/pnl-detail-2024.json')) as any);
    expect(txns).toContainEqual({ type: 'Invoice', id: '130' });
    expect(txns).toContainEqual({ type: 'Credit Card Credit', id: '109' });
    expect(txns).toHaveLength(11);
  });

  it('reads the A/R Aging grand total and CDC tombstones', async () => {
    expect(parseAgedReceivablesTotal(parseLossless(await fixture('sandbox/aged-receivables.json')) as any)).toBe('490.00');
    expect(parseCdc(parseLossless(await fixture('sandbox/cdc.json')))).toEqual([
      { entity: 'Invoice', id: '77', deletedAt: '2026-10-20T09:00:00-07:00' },
      { entity: 'Customer', id: '5', deletedAt: '2026-10-22T09:00:00-07:00' },
    ]);
  });
});

describe('fiscal years', () => {
  it('spans calendar years for a January start', () => {
    expect(fiscalYears('January', '2023-06-15', '2026-10-31').map((f) => [f.label, f.start, f.end])).toEqual([
      ['2023', '2023-01-01', '2023-12-31'],
      ['2024', '2024-01-01', '2024-12-31'],
      ['2025', '2025-01-01', '2025-12-31'],
      ['2026', '2026-01-01', '2026-12-31'],
    ]);
  });

  it('handles a fiscal year that starts mid-year', () => {
    expect(fiscalYears('April', '2023-03-10', '2024-04-02').map((f) => [f.label, f.start, f.end])).toEqual([
      ['FY 2022-23', '2022-04-01', '2023-03-31'],
      ['FY 2023-24', '2023-04-01', '2024-03-31'],
      ['FY 2024-25', '2024-04-01', '2025-03-31'],
    ]);
  });
});

describe('compare', () => {
  it('distinguishes exact match, reconciled, and unexplained differences', () => {
    expect(compare('100.00', '100', '0').status).toBe('match');
    expect(compare('100.00', '112.34', '12.34')).toMatchObject({ status: 'reconciled', difference: '12.34', unexplained: '0.00' });
    expect(compare('200.00', '250.00', '0')).toMatchObject({ status: 'difference', unexplained: '50.00' });
  });

  it('formats money for display only', () => {
    expect(fmtMoney('1234567.5')).toBe('1,234,567.50');
    expect(fmtMoney('-20')).toBe('-20.00');
    expect(fmtMoney(null)).toBe('—');
  });
});

describe('buildVerification', () => {
  it('reconciles income and expenses per year against the P&L, net of HST', async () => {
    const { report, calls } = await verify();
    const y2024 = report.years.find((y) => y.fy.label === '2024')!;
    expect(y2024.archive.income).toMatchObject({ invoices: '1500.00', creditMemos: '100.00', total: '1400.00', adjustments: { deposits: '12.34', journalEntries: '0.00' } });
    expect(y2024.income).toMatchObject({ archive: '1400.00', qbo: '1412.34', explained: '12.34', unexplained: '0.00', status: 'reconciled' });
    // 100 + 2000 (equipment) - 20 (card credit) + 50 - 10 = 2120; P&L excludes the 2000 asset and adds the 300 depreciation JE.
    expect(y2024.archive.expenses).toMatchObject({ purchases: '2080.00', total: '2120.00', adjustments: { journalEntries: '300.00', balanceSheetLines: '-2000.00' } });
    expect(y2024.expenses).toMatchObject({ qbo: '420.00', unexplained: '0.00', status: 'reconciled' });

    const y2025 = report.years.find((y) => y.fy.label === '2025')!;
    expect(y2025.income).toMatchObject({ archive: '200.00', qbo: '250.00', unexplained: '50.00', status: 'difference' });
    expect(report.years.map((y) => y.fy.label)).toEqual(['2024', '2025', '2026']);
    expect(calls.some((c) => c.startsWith('reports/ProfitAndLoss?') && c.includes('accounting_method=Accrual'))).toBe(true);
  });

  it('finds P&L transactions missing from the archive and reports unchecked types', async () => {
    const { report } = await verify();
    const cov = report.years.find((y) => y.fy.label === '2024')!.coverage!;
    expect(cov.missing).toEqual([{ type: 'Invoice', id: '999', entity: 'Invoice' }]);
    expect(cov.unmapped).toEqual({ 'Inventory Qty Adjust': 1 });
    expect(cov.checked).toBe(10);
  });

  it('compares open receivables with the A/R Aging total', async () => {
    const { report } = await verify();
    // 565 open - 50 unapplied credit - 25 unapplied payment
    expect(report.receivables).toMatchObject({ archive: { openInvoices: 1, total: '490.00' }, qbo: '490.00', status: 'match' });
  });

  it('records deletions from the change feed and whether the archive kept a copy', async () => {
    const { report, paths } = await verify();
    const cdc = report.deletions.cdc!;
    expect(cdc.deletions).toEqual([
      expect.objectContaining({ entity: 'Customer', id: '5', archived: true }),
      expect.objectContaining({ entity: 'Invoice', id: '77', archived: false }),
    ]);
    expect(cdc.newlySeen).toBe(2);
    expect(report.deletions.notReturnedByQbo).toEqual([{ entity: 'Invoice', ids: ['44'] }]);
    const saved = JSON.parse(await readFile(join(paths.root, 'state', 'deletions.json'), 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['Customer/5', 'Invoice/77']);
  });

  it('treats deletions from before the first export as informational', async () => {
    const { report } = await verify(manifestFor({ firstExportStartedAt: '2026-10-25T00:00:00Z' }));
    expect(report.deletions.beforeArchive).toBe(1);
    expect(report.attention.some((a) => /deleted/.test(a))).toBe(false);
    expect(renderMarkdown(report)).toContain('ℹ️ none (deleted before the first export)');
  });

  it('falls back to one CDC call per entity when the batch is rejected', async () => {
    const api = await reportsApi({
      cdc: (entities) =>
        entities.includes(',') || entities === 'PurchaseOrder' ? fault(400, '4000', 'Unsupported entity', entities) : json(200, '{"CDCResponse":[{"QueryResponse":[]}]}'),
    });
    const { report } = await verify(manifestFor(), api);
    expect(report.deletions.cdc!.unavailable.map((u) => u.entity)).toEqual(['PurchaseOrder']);
    expect(report.problems).toContainEqual(expect.objectContaining({ kind: 'skipped', area: 'Deletion check', item: 'PurchaseOrder' }));
  });

  it('flags count mismatches, failures and skips, and sets the overall status', async () => {
    const manifest = manifestFor();
    manifest.entities.Bill = { fetched: 14, qboCount: 15, filesInArchive: 14, notReturnedByQbo: [], status: 'complete' };
    manifest.entities.Deposit = { fetched: 0, qboCount: null, filesInArchive: 1, notReturnedByQbo: [], status: 'failed', error: 'HTTP 500' };
    const { report } = await verify(manifest);
    expect(report.overall).toBe('attention');
    expect(report.attention).toEqual(
      expect.arrayContaining([
        'Bill: fetched 14 records but QuickBooks counts 15.',
        '1 entity did not finish exporting.',
        expect.stringMatching(/^2025: income differs from the P&L by 50.00/),
        expect.stringMatching(/^2024: 1 transaction\(s\) in the QuickBooks P&L are not in the archive/),
        expect.stringMatching(/^1 record\(s\) were created and deleted in QuickBooks between exports/),
      ]),
    );
    expect(report.problems).toContainEqual({ kind: 'failed', area: 'Records', item: 'Deposit', reason: 'HTTP 500' });
    expect(report.problems).toContainEqual({ kind: 'skipped', area: 'Records', item: 'Class', reason: 'Not available on Essentials' });
  });

  it('keeps going when a report call fails, and records why', async () => {
    const base = await reportsApi();
    const api = {
      calls: base.calls,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        input.toString().includes('/reports/AgedReceivables') ? fault(400, '2020', 'Required param missing') : base.fetch(input, init)) as typeof fetch,
    };
    const { report } = await verify(manifestFor(), api);
    expect(report.receivables).toMatchObject({ qbo: null, status: null });
    expect(report.attention).toContain('The A/R Aging check could not run.');
    expect(report.years.length).toBe(3); // the rest still ran
  });

  it('writes Markdown and JSON reports', async () => {
    const { report, paths } = await verify();
    const { markdown } = await writeVerification(paths, report);
    const md = await readFile(markdown, 'utf8');
    expect(md).toContain('# QuickBooks export verification report');
    expect(md).toContain('## 1. Record counts');
    expect(md).toContain('| 2024 | 1,400.00 | 1,412.34 | 12.34 | 12.34 | 0.00 | ✅ reconciled |');
    expect(md).toContain('⚠️ Invoice #999');
    expect(md).toContain('Deleted transactions are not retrievable');
    expect(renderMarkdown(report)).toBe(md);
    const saved = JSON.parse(await readFile(join(paths.report, 'verification.json'), 'utf8'));
    expect(saved.years[0].income.qbo).toBe('1412.34');
  });

  it('reconciles inventory purchases, expenses coded to income, and COGS on inventory sales (real P&L Detail layout)', async () => {
    const paths = await initArchive(join(await tempDir(), 'archive'));
    await put(paths, 'CompanyInfo', '1', '{"Id":"1","CompanyName":"Inventory Co","FiscalYearStartMonth":"January"}');
    await put(paths, 'Account', '1', '{"Id":"1","Classification":"Revenue"}');
    await put(paths, 'Account', '2', '{"Id":"2","Classification":"Expense"}');
    await put(paths, 'Account', '81', '{"Id":"81","Name":"Inventory Asset","Classification":"Asset"}');
    await put(paths, 'Item', '5', '{"Id":"5","Name":"Pump","Type":"Inventory","AssetAccountRef":{"value":"81"},"ExpenseAccountRef":{"value":"2"}}');
    await put(paths, 'Invoice', '119', '{"Id":"119","TxnDate":"2026-03-01","TotalAmt":300.00,"Balance":0}');
    // Bought a pump for stock (asset, not a P&L expense) plus office supplies.
    await put(paths, 'Purchase', '115', '{"Id":"115","TxnDate":"2026-03-02","TotalAmt":160.00,"Line":[{"Amount":125.00,"DetailType":"ItemBasedExpenseLineDetail","ItemBasedExpenseLineDetail":{"ItemRef":{"value":"5"}}},{"Amount":35.00,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"value":"2"}}}]}');
    // An expense coded to an income account: QBO shows it as negative income.
    await put(paths, 'Purchase', '80', '{"Id":"80","TxnDate":"2026-03-03","TotalAmt":24.36,"Line":[{"Amount":24.36,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"value":"1"}}}]}');

    const row = (type: string, id: string, amount: string) => `{"ColData":[{"value":"2026-03-01"},{"value":"${type}","id":"${id}"},{"value":""},{"value":""},{"value":""},{"value":""},{"value":"${amount}"},{"value":""}],"type":"Data"}`;
    const section = (title: string, rows: string[]) => `{"Header":{"ColData":[{"value":"${title}"}]},"Rows":{"Row":[{"Header":{"ColData":[{"value":"Some account"}]},"Rows":{"Row":[${rows.join(',')}]},"type":"Section"}]},"type":"Section"}`;
    const detail = `{"Columns":{"Column":[{"ColTitle":"Date","MetaData":[{"Name":"ColKey","Value":"tx_date"}]},{"ColTitle":"Transaction Type","MetaData":[{"Name":"ColKey","Value":"txn_type"}]},{"ColTitle":"Num","MetaData":[{"Name":"ColKey","Value":"doc_num"}]},{"ColTitle":"Name","MetaData":[{"Name":"ColKey","Value":"name"}]},{"ColTitle":"Memo/Description","MetaData":[{"Name":"ColKey","Value":"memo"}]},{"ColTitle":"Split","MetaData":[{"Name":"ColKey","Value":"split_acc"}]},{"ColTitle":"Amount","MetaData":[{"Name":"ColKey","Value":"subt_nat_amount"}]},{"ColTitle":"Balance","MetaData":[{"Name":"ColKey","Value":"rbal_nat_amount"}]}]},
      "Rows":{"Row":[{"Header":{"ColData":[{"value":"Ordinary Income/Expenses"}]},"Rows":{"Row":[
        ${section('Income', [row('Invoice', '119', '300.00'), row('Expense', '80', '-24.36')])},
        ${section('Cost of Goods Sold', [row('Invoice', '119', '90.00')])},
        ${section('Expenses', [row('Expense', '115', '35.00')])}
      ]},"type":"Section"}]}}`;
    const pnl = `{"Header":{"ReportBasis":"Accrual"},"Rows":{"Row":[{"group":"Income","Summary":{"ColData":[{"value":"Total Income"},{"value":"275.64"}]}},{"group":"COGS","Summary":{"ColData":[{"value":"Total Cost of Goods Sold"},{"value":"90.00"}]}},{"group":"Expenses","Summary":{"ColData":[{"value":"Total Expenses"},{"value":"35.00"}]}}]}}`;
    const fetchFn = (async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/reports/ProfitAndLoss')) return json(200, pnl);
      if (path.endsWith('/reports/ProfitAndLossDetail')) return json(200, detail);
      if (path.endsWith('/reports/AgedReceivables')) return json(200, await fixture('sandbox/aged-receivables.json'));
      return json(200, '{"CDCResponse":[{"QueryResponse":[]}]}');
    }) as typeof fetch;
    const client = await makeClient(fetchFn);
    const report = await buildVerification(paths, { client, log: silentLogger, manifest: manifestFor(), allEntities: ENTITIES.map((e) => e.name), now: () => NOW });
    const y = report.years[0]!;
    expect(y.income).toMatchObject({ archive: '300.00', qbo: '275.64', explained: '-24.36', status: 'reconciled' });
    // 160 + 24.36 archived; minus 125 inventory (asset) and 24.36 coded to income; plus 90 COGS from the sale.
    expect(y.archive.expenses.adjustments).toMatchObject({ balanceSheetLines: '-125.00', incomeAccountLines: '-24.36', inventoryCostOfSales: '90.00' });
    expect(y.expenses).toMatchObject({ archive: '184.36', qbo: '125.00', unexplained: '0.00', status: 'reconciled' });
    expect(y.coverage).toMatchObject({ checked: 3, missing: [] });
  });
});
