import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportRecords, withArchiveLock } from '../src/export/exporter.ts';
import { runExport } from '../src/export/run.ts';
import { silentLogger } from '../src/log.ts';
import { fakeQbo, fault, makeClient, tempDir } from './helpers.ts';

const inv = (id: number, total = '100.00', updated = '2024-06-01T10:00:00-04:00') =>
  `{"Id":"${id}","DocNumber":"10${id}","TxnDate":"2024-0${(id % 9) + 1}-15","CustomerRef":{"value":"1","name":"Acme Ltd"},"TotalAmt":${total},"Balance":0.00,"MetaData":{"LastUpdatedTime":"${updated}"}}`;
const cust = (id: number, active: boolean) => `{"Id":"${id}","DisplayName":"Customer ${id}","Active":${active},"Balance":0}`;

async function run(dir: string, fetchFn: typeof fetch, opts: { only: string[]; since?: string; fresh?: boolean; pageSize?: number }) {
  const client = await makeClient(fetchFn);
  return withArchiveLock(dir, (paths) => exportRecords(paths, { client, log: silentLogger, pageSize: 2, ...opts }));
}

describe('exportRecords', () => {
  it('paginates with STARTPOSITION/MAXRESULTS and writes untouched records', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({ Invoice: [inv(1, '1130.10'), inv(2), inv(3), inv(4), inv(5)] });
    const { state } = await run(dir, qbo.fetch, { only: ['Invoice'] });

    expect(qbo.queries.filter((q) => q.startsWith('SELECT *'))).toEqual([
      'SELECT * FROM Invoice ORDERBY Id STARTPOSITION 1 MAXRESULTS 2',
      'SELECT * FROM Invoice ORDERBY Id STARTPOSITION 3 MAXRESULTS 2',
      'SELECT * FROM Invoice ORDERBY Id STARTPOSITION 5 MAXRESULTS 2',
    ]);
    expect(state.entities.Invoice).toMatchObject({ status: 'complete', fetched: 5, qboCount: 5 });
    expect((await readdir(join(dir, 'raw', 'Invoice'))).sort()).toEqual(['1.json', '2.json', '3.json', '4.json', '5.json']);
    const raw = await readFile(join(dir, 'raw', 'Invoice', '1.json'), 'utf8');
    expect(raw).toContain('"TotalAmt": 1130.10');
    expect(raw).toContain('"Balance": 0.00');
  });

  it('fetches a final empty page when the last page is exactly full', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({ Invoice: [inv(1), inv(2)] });
    const { state } = await run(dir, qbo.fetch, { only: ['Invoice'] });
    expect(qbo.queries.filter((q) => q.startsWith('SELECT *'))).toHaveLength(2);
    expect(state.entities.Invoice!.fetched).toBe(2);
  });

  it('includes inactive customers', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({ Customer: [cust(1, true), cust(2, false), cust(3, true)] });
    const { state } = await run(dir, qbo.fetch, { only: ['Customer'] });
    expect(state.entities.Customer).toMatchObject({ status: 'complete', fetched: 3, qboCount: 3 });
    expect(qbo.queries[0]).toContain('Active IN (true, false)');
  });

  it('falls back to simpler query forms when QBO rejects one, still covering inactive records', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({ TaxRate: [cust(1, true), cust(2, false)] }, (q) =>
      / IN \(|ORDERBY/.test(q) ? fault(400, '4000', 'Invalid query', 'QueryValidationError: not supported') : undefined,
    );
    const { state } = await run(dir, qbo.fetch, { only: ['TaxRate'] });
    expect(state.entities.TaxRate).toMatchObject({ status: 'complete', fetched: 2, qboCount: 2, strategy: 3 });
    expect(qbo.queries).toContain('SELECT * FROM TaxRate WHERE Active = false STARTPOSITION 1 MAXRESULTS 2');
  });

  it('marks plan-gated entities as skipped instead of failing', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({}, (q) => (q.includes('FROM Class') ? fault(400, '6000', 'Feature Not Supported', 'Class tracking is not enabled') : undefined));
    const { state } = await run(dir, qbo.fetch, { only: ['Class'] });
    expect(state.entities.Class!.status).toBe('skipped');
    expect(state.entities.Class!.note).toMatch(/Essentials/);
    expect(state.finishedAt).not.toBeNull();
  });

  it('resumes a failed entity from the page where it stopped', async () => {
    const dir = await tempDir();
    const data = { Invoice: [inv(1), inv(2), inv(3), inv(4), inv(5)] };
    const first = fakeQbo(data, (q) => (q.includes('STARTPOSITION 3') ? fault(400, '6000', 'Business validation error') : undefined));
    const r1 = await run(dir, first.fetch, { only: ['Invoice'] });
    expect(r1.state.entities.Invoice).toMatchObject({ status: 'failed', nextStartPosition: 3 });
    expect(r1.state.finishedAt).toBeNull();

    const second = fakeQbo(data);
    const r2 = await run(dir, second.fetch, { only: ['Invoice'] });
    expect(r2.resumed).toBe(true);
    expect(second.queries[0]).toBe('SELECT * FROM Invoice ORDERBY Id STARTPOSITION 3 MAXRESULTS 2');
    expect(r2.state.entities.Invoice).toMatchObject({ status: 'complete', fetched: 5, qboCount: 5 });
    expect(r2.state.runId).toBe(r1.state.runId);
  });

  it('starts a new full pass after a completed run and reports records QBO no longer returns', async () => {
    const dir = await tempDir();
    await run(dir, fakeQbo({ Invoice: [inv(1), inv(2), inv(3)] }).fetch, { only: ['Invoice'] });
    const again = fakeQbo({ Invoice: [inv(1), inv(3)] });
    const r2 = await run(dir, again.fetch, { only: ['Invoice'] });
    expect(r2.resumed).toBe(false);
    expect(again.queries[0]).toContain('STARTPOSITION 1');
    expect(r2.state.entities.Invoice!.notReturnedByQbo).toEqual(['2']);
    expect(await readdir(join(dir, 'raw', 'Invoice'))).toContain('2.json'); // kept: the only copy
  });

  it('--since filters by LastUpdatedTime and does not flag unchanged records as missing', async () => {
    const dir = await tempDir();
    const data = { Invoice: [inv(1, '1.00', '2023-01-01T00:00:00Z'), inv(2, '2.00', '2025-03-01T00:00:00Z')] };
    await run(dir, fakeQbo(data).fetch, { only: ['Invoice'] });
    const incr = fakeQbo(data);
    const r = await run(dir, incr.fetch, { only: ['Invoice'], since: '2025-01-01' });
    expect(incr.queries[0]).toContain("WHERE MetaData.LastUpdatedTime >= '2025-01-01'");
    expect(r.state.entities.Invoice).toMatchObject({ fetched: 1, qboCount: 1, notReturnedByQbo: [] });
  });

  it('refuses to mix companies in one archive', async () => {
    const dir = await tempDir();
    await run(dir, fakeQbo({ Invoice: [inv(1)] }).fetch, { only: ['Invoice'] });
    const other = await makeClient(fakeQbo({}).fetch, '1111');
    await expect(withArchiveLock(dir, (paths) => exportRecords(paths, { client: other, log: silentLogger, only: ['Invoice'] }))).rejects.toThrow(
      /belongs to company/,
    );
  });

  it('refuses a second concurrent export into the same folder', async () => {
    const dir = await tempDir();
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holding = withArchiveLock(dir, () => {
      locked();
      return new Promise<void>((r) => (release = r));
    });
    await isLocked;
    await expect(withArchiveLock(dir, async () => {})).rejects.toThrow(/already running/);
    release();
    await holding;
  });
});

describe('runExport', () => {
  it('writes the manifest and CSVs', async () => {
    const dir = await tempDir();
    const qbo = fakeQbo({
      CompanyInfo: ['{"Id":"1","CompanyName":"Sandbox Company_CA_1","Country":"CA"}'],
      Invoice: [inv(1, '1130.10')],
      Customer: [cust(1, true), cust(2, false)],
    });
    const client = await makeClient(qbo.fetch);
    const { manifest, csvFiles } = await runExport({
      client,
      log: silentLogger,
      outDir: dir,
      only: ['CompanyInfo', 'Invoice', 'Customer'],
      environment: 'sandbox',
      minorVersion: '75',
    });
    expect(manifest).toMatchObject({ schemaVersion: 1, realmId: '9341453000000000', companyName: 'Sandbox Company_CA_1', minorVersion: '75', since: null });
    expect(manifest.entities.Customer).toMatchObject({ status: 'complete', fetched: 2, qboCount: 2, filesInArchive: 2 });
    expect(manifest.entities.CompanyInfo).toMatchObject({ status: 'complete', fetched: 1, qboCount: null });
    expect(csvFiles).toContain('invoices.csv');
    const invoicesCsv = await readFile(join(dir, 'csv', 'invoices.csv'), 'utf8');
    expect(invoicesCsv).toContain('1130.10');
    expect(invoicesCsv).toContain('Paid');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  });
});
