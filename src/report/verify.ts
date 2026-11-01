import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { QboClient } from '../api/client.ts';
import type { ArchivePaths, AttachmentRecord, AttachmentSummary, Manifest } from '../archive/layout.ts';
import { TOOL_VERSION } from '../config.ts';
import { readRawRecords } from '../export/csv.ts';
import type { Logger } from '../log.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { addDecimal, isZero, subDecimal } from '../util/decimal.ts';
import {
  computeOpenReceivables,
  computeYearTotals,
  earliestTxnDate,
  fiscalYears,
  type FiscalYear,
  type OpenReceivables,
  type YearTotals,
} from './archive-totals.ts';
import { checkDeletions, CDC_WINDOW_DAYS, type CdcResult } from './cdc.ts';
import { entityForTxnType, fetchAgedReceivablesTotal, fetchPnl, fetchPnlDetailRows, inventoryCostOfSales, type PnlTotals } from './reports-api.ts';

export type CompareStatus = 'match' | 'reconciled' | 'difference';

export interface Comparison {
  /** From the archive. */
  archive: string;
  /** From the QBO report. */
  qbo: string;
  /** qbo - archive */
  difference: string;
  /** Part of the difference accounted for by known causes (journal entries, deposits, ...). */
  explained: string;
  unexplained: string;
  status: CompareStatus;
}

export interface YearCheck {
  fy: FiscalYear;
  archive: YearTotals;
  pnl: PnlTotals | null;
  income: Comparison | null;
  expenses: Comparison | null;
  /** P&L Detail transactions checked against the archive. */
  coverage: { checked: number; missing: Array<{ type: string; id: string; entity: string }>; unmapped: Record<string, number> } | null;
  error?: string;
}

export interface Problem {
  kind: 'failed' | 'skipped' | 'flagged' | 'error';
  area: string;
  item: string;
  reason: string;
}

export interface VerificationReport {
  generatedAt: string;
  toolVersion: string;
  environment: string;
  realmId: string;
  companyName: string | null;
  firstExportStartedAt: string | null;
  basis: string;
  since: string | null;
  /** True when some entities have never been exported into this archive (--only). */
  partial: boolean;
  overall: 'pass' | 'attention';
  attention: string[];
  counts: Array<{
    entity: string;
    status: string;
    fetched: number;
    qboCount: number | null;
    filesInArchive: number;
    ok: boolean;
    note?: string;
  }>;
  attachments: { summary: AttachmentSummary | null; problems: AttachmentRecord[] };
  years: YearCheck[];
  receivables: { archive: OpenReceivables; qbo: string | null; difference: string | null; status: CompareStatus | null; error?: string } | null;
  deletions: {
    cdc: CdcResult | null;
    error?: string;
    notReturnedByQbo: Array<{ entity: string; ids: string[] }>;
    /** Unarchived deletions that happened before the first export (expected, informational). */
    beforeArchive?: number;
  };
  problems: Problem[];
  limitations: string[];
}

export interface VerifyOptions {
  client: QboClient;
  log: Logger;
  manifest: Manifest;
  /** All entity names this tool exports; used to detect partial archives. */
  allEntities: string[];
  now?: () => Date;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function compare(archive: string, qbo: string, explained: string): Comparison {
  const difference = subDecimal(qbo, archive);
  const unexplained = subDecimal(difference, explained);
  const status: CompareStatus = isZero(difference) ? 'match' : isZero(unexplained) ? 'reconciled' : 'difference';
  return { archive, qbo, difference, explained, unexplained, status };
}

export async function buildVerification(paths: ArchivePaths, options: VerifyOptions): Promise<VerificationReport> {
  const now = (options.now ?? (() => new Date()))();
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const { client, manifest, log } = options;
  const problems: Problem[] = [];
  const attention: string[] = [];

  const [companyInfo] = await readRawRecords(paths, 'CompanyInfo');
  const [prefs] = await readRawRecords(paths, 'Preferences');
  const reportPrefs = (prefs?.ReportPrefs ?? {}) as { ReportBasis?: string };
  const basis = reportPrefs.ReportBasis === 'Cash' ? 'Cash' : 'Accrual';

  // 1. Record counts
  const counts = Object.entries(manifest.entities).map(([entity, e]) => {
    const ok = e.status === 'skipped' || (e.status === 'complete' && (e.qboCount === null || e.qboCount === e.fetched));
    if (e.status === 'failed' || e.status === 'incomplete') {
      problems.push({ kind: 'failed', area: 'Records', item: entity, reason: e.error ?? 'Did not finish' });
    } else if (e.status === 'skipped') {
      problems.push({ kind: 'skipped', area: 'Records', item: entity, reason: e.note ?? 'Skipped' });
    } else if (!ok) {
      attention.push(`${entity}: fetched ${e.fetched} records but QuickBooks counts ${e.qboCount}.`);
    }
    return { entity, status: e.status, fetched: e.fetched, qboCount: e.qboCount, filesInArchive: e.filesInArchive, ok, ...(e.note ? { note: e.note } : {}) };
  });
  const failedEntities = counts.filter((c) => c.status === 'failed' || c.status === 'incomplete');
  if (failedEntities.length > 0) attention.push(`${failedEntities.length} entit${failedEntities.length === 1 ? 'y' : 'ies'} did not finish exporting.`);
  const partial = options.allEntities.some((n) => !manifest.entities[n]);

  // 2. Attachments
  const attachmentProblems = manifest.attachments.filter((a) => a.status === 'failed' || a.sizeMatches === false);
  for (const a of manifest.attachments) {
    if (a.status === 'failed') problems.push({ kind: 'failed', area: 'Attachments', item: `${a.attachableId} ${a.fileName ?? ''}`.trim(), reason: a.error ?? 'Download failed' });
    if (a.sizeMatches === false) problems.push({ kind: 'flagged', area: 'Attachments', item: `${a.attachableId} ${a.fileName ?? ''}`.trim(), reason: a.error ?? 'Size differs from QuickBooks' });
    if (a.status === 'skipped') problems.push({ kind: 'skipped', area: 'Attachments', item: `${a.attachableId} ${a.fileName ?? ''}`.trim(), reason: a.note ?? 'Not downloaded' });
  }
  const failedFiles = manifest.attachments.filter((a) => a.status === 'failed').length;
  if (failedFiles > 0) attention.push(`${failedFiles} attachment file(s) failed to download.`);

  // 3 + 4. Per fiscal year: P&L totals and P&L Detail transaction coverage
  const years: YearCheck[] = [];
  const first = await earliestTxnDate(paths);
  if (first) {
    const fys = fiscalYears(typeof companyInfo?.FiscalYearStartMonth === 'string' ? companyInfo.FiscalYearStartMonth : null, first, today);
    const totals = await computeYearTotals(paths, fys);
    for (const t of totals) {
      const check: YearCheck = { fy: t.fy, archive: t, pnl: null, income: null, expenses: null, coverage: null };
      try {
        const pnl = await fetchPnl(client, paths, t.fy, basis);
        check.pnl = pnl;
        const detailRows = await fetchPnlDetailRows(client, paths, t.fy, basis);
        const ia = t.income.adjustments;
        const ea = t.expenses.adjustments;
        ea.inventoryCostOfSales = inventoryCostOfSales(detailRows);
        check.income = compare(t.income.total, pnl.totalIncome, addDecimal(ia.journalEntries, ia.deposits, ia.expenseLines));
        check.expenses = compare(
          t.expenses.total,
          pnl.totalExpenses,
          addDecimal(ea.journalEntries, ea.deposits, ea.balanceSheetLines, ea.incomeAccountLines, ea.inventoryCostOfSales),
        );
        if (check.income.status === 'difference') attention.push(`${t.fy.label}: income differs from the P&L by ${check.income.unexplained} that the archive can't explain.`);
        if (check.expenses.status === 'difference') attention.push(`${t.fy.label}: expenses differ from the P&L by ${check.expenses.unexplained} that the archive can't explain.`);

        const txns = [...new Map(detailRows.map((r) => [`${r.type}/${r.id}`, r])).values()];
        const missing: Array<{ type: string; id: string; entity: string }> = [];
        const unmapped: Record<string, number> = {};
        let checked = 0;
        for (const txn of txns) {
          const entity = entityForTxnType(txn.type);
          if (!entity) {
            unmapped[txn.type] = (unmapped[txn.type] ?? 0) + 1;
            continue;
          }
          checked++;
          const exists = await stat(paths.rawRecord(entity, txn.id)).then(() => true, () => false);
          if (!exists) missing.push({ type: txn.type, id: txn.id, entity });
        }
        check.coverage = { checked, missing, unmapped };
        if (missing.length > 0) attention.push(`${t.fy.label}: ${missing.length} transaction(s) in the QuickBooks P&L are not in the archive.`);
      } catch (err) {
        check.error = errText(err);
        problems.push({ kind: 'error', area: 'Profit & Loss check', item: t.fy.label, reason: check.error });
        attention.push(`${t.fy.label}: the Profit & Loss check could not run.`);
        log.warn({ fy: t.fy.label, error: check.error }, 'P&L verification failed');
      }
      years.push(check);
    }
  }

  // 5. Accounts receivable
  let receivables: VerificationReport['receivables'] = null;
  const ar = await computeOpenReceivables(paths);
  try {
    const qbo = await fetchAgedReceivablesTotal(client, paths, today);
    const difference = subDecimal(qbo, ar.total);
    const status: CompareStatus = isZero(difference) ? 'match' : 'difference';
    receivables = { archive: ar, qbo, difference, status };
    if (status === 'difference') attention.push(`Accounts receivable: archive shows ${ar.total} owing, the A/R Aging report shows ${qbo}.`);
  } catch (err) {
    receivables = { archive: ar, qbo: null, difference: null, status: null, error: errText(err) };
    problems.push({ kind: 'error', area: 'A/R check', item: 'AgedReceivables', reason: errText(err) });
    attention.push('The A/R Aging check could not run.');
  }

  // 6. Deletions
  const deletions: VerificationReport['deletions'] = {
    cdc: null,
    notReturnedByQbo: Object.entries(manifest.entities)
      .filter(([, e]) => e.notReturnedByQbo.length > 0)
      .map(([entity, e]) => ({ entity, ids: e.notReturnedByQbo })),
  };
  try {
    deletions.cdc = await checkDeletions(client, paths, now);
    for (const u of deletions.cdc.unavailable) problems.push({ kind: 'skipped', area: 'Deletion check', item: u.entity, reason: u.reason });
    // Deleted before this archive existed: nothing could have saved it, so it's informational.
    // Deleted later but never captured (created and deleted between runs): worth attention.
    const archiveStart = manifest.firstExportStartedAt ?? manifest.exportStartedAt;
    const unarchived = deletions.cdc.deletions.filter((d) => !d.archived);
    const missed = unarchived.filter((d) => d.deletedAt === null || Date.parse(d.deletedAt) >= Date.parse(archiveStart));
    if (missed.length > 0) {
      attention.push(`${missed.length} record(s) were created and deleted in QuickBooks between exports, so the archive never captured them; they cannot be recovered through the API.`);
    }
    deletions.beforeArchive = unarchived.length - missed.length;
  } catch (err) {
    deletions.error = errText(err);
    problems.push({ kind: 'error', area: 'Deletion check', item: 'ChangeDataCapture', reason: deletions.error });
  }

  return {
    generatedAt: now.toISOString(),
    toolVersion: TOOL_VERSION,
    environment: manifest.environment,
    realmId: manifest.realmId,
    companyName: manifest.companyName,
    firstExportStartedAt: manifest.firstExportStartedAt ?? manifest.exportStartedAt,
    basis,
    since: manifest.since,
    partial,
    overall: attention.length === 0 ? 'pass' : 'attention',
    attention,
    counts,
    attachments: { summary: manifest.attachmentSummary, problems: attachmentProblems },
    years,
    receivables,
    deletions,
    problems,
    limitations: [
      'Deleted transactions are not retrievable: QuickBooks queries never return them. ' +
        `The change feed (CDC) reports deletions only for the last ${CDC_WINDOW_DAYS} days, and only as an ID. ` +
        'Records deleted before they were ever archived cannot be recovered through the API.',
      'Archived records that QuickBooks no longer returns are kept (see "No longer returned by QuickBooks").',
      'Attachments not linked to any transaction (Receipts inbox) are not downloaded unless --include-unlinked is used.',
      'Totals compare the archive with QuickBooks reports on the company\'s own basis (' + basis + '), net of sales tax (HST/GST).',
    ],
  };
}

// ---------- Markdown ----------

/** 1234567.5 -> 1,234,567.50 (presentation only; JSON keeps the exact strings). */
export function fmtMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return value;
  const frac = (m[3] ?? '').padEnd(2, '0');
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

const STATUS_LABEL: Record<CompareStatus, string> = { match: '✅ match', reconciled: '✅ reconciled', difference: '⚠️ difference' };
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(r: VerificationReport): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);
  const table = (headers: string[], rows: string[][]) => {
    p(`| ${headers.join(' | ')} |`);
    p(`| ${headers.map((h, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`);
    for (const row of rows) p(`| ${row.map(esc).join(' | ')} |`);
    p();
  };

  p('# QuickBooks export verification report');
  p();
  p(`- **Company:** ${r.companyName ?? '(unknown)'} (realm ${r.realmId}, ${r.environment})`);
  p(`- **Generated:** ${r.generatedAt} by qbo-export ${r.toolVersion}`);
  p(`- **Reporting basis:** ${r.basis}`);
  if (r.since) p(`- **Incremental run:** records changed since ${r.since}; totals below use the whole archive.`);
  if (r.partial) p('- **Partial archive:** some entities have never been exported into this folder (`--only`), so totals may not reconcile.');
  p();
  p(r.overall === 'pass' ? '## ✅ All checks passed' : `## ⚠️ ${r.attention.length} item(s) need attention`);
  p();
  for (const a of r.attention) p(`- ${a}`);
  if (r.attention.length > 0) p();

  p('## 1. Record counts');
  p();
  p('Records fetched in this run compared with QuickBooks\' own `select count(*)`.');
  p();
  table(
    ['Entity', 'Status', 'Fetched', 'QuickBooks count', 'In archive', 'Check'],
    r.counts.map((c) => [c.entity, c.status, String(c.fetched), c.qboCount === null ? '—' : String(c.qboCount), String(c.filesInArchive), c.status === 'skipped' ? '— skipped' : c.ok ? '✅' : '⚠️']),
  );

  p('## 2. Attachments');
  p();
  const a = r.attachments.summary;
  if (!a) p('Attachments were not processed in this run.');
  else {
    table(
      ['Found', 'With a file', 'Notes only', 'Downloaded now', 'Already archived (verified)', 'Failed', 'Size mismatch (kept)', 'Unlinked', 'Unlinked not downloaded', 'Total size'],
      [[a.found, a.withFile, a.noteOnly, a.downloaded, a.alreadyVerified, a.failed, a.sizeMismatches, a.unlinked, a.skippedUnlinked, `${a.totalBytes.toLocaleString('en-CA')} bytes`].map(String)],
    );
  }

  p(`## 3. Yearly totals vs Profit & Loss (${r.basis})`);
  p();
  p(
    'Archive totals are net of sales tax. "Explained" is the part of the difference with a known cause: journal entries; deposits posted straight to income/expense accounts; ' +
      'expense lines posted to balance-sheet accounts (equipment, inventory, loans) or coded to an income account; and cost of goods sold on inventory sales ' +
      '(taken from QuickBooks\' P&L Detail, since the archive has no inventory cost history).',
  );
  p();
  const cmpRows = (pick: (y: YearCheck) => Comparison | null) =>
    r.years.map((y) => {
      const c = pick(y);
      if (!c) return [y.fy.label, '—', '—', '—', '—', '—', y.error ? `❌ ${y.error}` : '—'];
      return [y.fy.label, fmtMoney(c.archive), fmtMoney(c.qbo), fmtMoney(c.difference), fmtMoney(c.explained), fmtMoney(c.unexplained), STATUS_LABEL[c.status]];
    });
  if (r.years.length === 0) p('No transactions in the archive.');
  else {
    p('### Income');
    p();
    table(['Year', 'Archive (invoices + sales receipts − credits/refunds)', 'P&L total income', 'Difference', 'Explained', 'Unexplained', 'Check'], cmpRows((y) => y.income));
    p('### Expenses');
    p();
    table(['Year', 'Archive (expenses + bills − vendor credits)', 'P&L total expenses incl. COGS', 'Difference', 'Explained', 'Unexplained', 'Check'], cmpRows((y) => y.expenses));
    p('<details><summary>Breakdown by year</summary>');
    p();
    table(
      ['Year', 'Invoices', 'Sales receipts', 'Credit memos', 'Refunds', 'JE → income', 'Deposits → income', 'Expense lines → income'],
      r.years.map((y) => {
        const i = y.archive.income;
        return [y.fy.label, i.invoices, i.salesReceipts, i.creditMemos, i.refundReceipts, i.adjustments.journalEntries, i.adjustments.deposits, i.adjustments.expenseLines].map((v, k) => (k === 0 ? v : fmtMoney(v)));
      }),
    );
    table(
      ['Year', 'Expenses', 'Bills', 'Vendor credits', 'JE → expense', 'Deposits → expense', 'Balance-sheet lines', 'Lines coded to income', 'COGS on inventory sales'],
      r.years.map((y) => {
        const e = y.archive.expenses;
        const a = e.adjustments;
        return [y.fy.label, e.purchases, e.bills, e.vendorCredits, a.journalEntries, a.deposits, a.balanceSheetLines, a.incomeAccountLines, a.inventoryCostOfSales].map((v, k) => (k === 0 ? v : fmtMoney(v)));
      }),
    );
    p('</details>');
    p();
  }

  p('## 4. Transactions in the QuickBooks P&L found in the archive');
  p();
  table(
    ['Year', 'Transactions checked', 'Missing from archive', 'Types not checked'],
    r.years.map((y) =>
      y.coverage
        ? [y.fy.label, String(y.coverage.checked), y.coverage.missing.length === 0 ? '✅ 0' : `⚠️ ${y.coverage.missing.map((m) => `${m.type} #${m.id}`).join(', ')}`, Object.entries(y.coverage.unmapped).map(([t, n]) => `${t} (${n})`).join(', ') || '—']
        : [y.fy.label, '—', y.error ? `❌ ${y.error}` : '—', '—'],
    ),
  );

  p('## 5. Accounts receivable vs A/R Aging');
  p();
  if (r.receivables) {
    const ar = r.receivables;
    table(
      ['Open invoices', 'Invoice balances', 'Unapplied credits', 'Unapplied payments', 'Archive total owing', 'A/R Aging total', 'Difference', 'Check'],
      [[String(ar.archive.openInvoices), fmtMoney(ar.archive.invoiceBalances), fmtMoney(ar.archive.unappliedCredits), fmtMoney(ar.archive.unappliedPayments), fmtMoney(ar.archive.total), fmtMoney(ar.qbo), fmtMoney(ar.difference), ar.status ? STATUS_LABEL[ar.status] : `❌ ${ar.error}`]],
    );
  }

  p('## 6. Deleted records');
  p();
  const cdc = r.deletions.cdc;
  if (cdc) {
    p(`QuickBooks' change feed (last ${CDC_WINDOW_DAYS} days, since ${cdc.changedSince}) plus earlier runs: **${cdc.deletions.length}** deletion(s) known, ${cdc.newlySeen} new in this run.`);
    p();
    if (cdc.deletions.length > 0) {
      const firstExport = r.firstExportStartedAt ? Date.parse(r.firstExportStartedAt) : Number.NaN;
      table(
        ['Entity', 'Id', 'Deleted at', 'Archived copy'],
        cdc.deletions.map((d) => [
          d.entity,
          d.id,
          d.deletedAt ?? '—',
          d.archived ? '✅ kept' : d.deletedAt && Date.parse(d.deletedAt) < firstExport ? 'ℹ️ none (deleted before the first export)' : '❌ none (deleted between exports)',
        ]),
      );
    }
  } else p(`The deletion check could not run: ${r.deletions.error ?? 'unknown error'}.`);
  if (r.deletions.notReturnedByQbo.length > 0) {
    p('**No longer returned by QuickBooks** (archived copies kept; most likely deleted in QuickBooks):');
    p();
    for (const n of r.deletions.notReturnedByQbo) p(`- ${n.entity}: ${n.ids.join(', ')}`);
    p();
  }

  p('## 7. Failures and skipped items');
  p();
  if (r.problems.length === 0) p('None.');
  else table(['Kind', 'Area', 'Item', 'Reason'], r.problems.map((x) => [x.kind, x.area, x.item, x.reason]));
  p();

  p('## Limitations');
  p();
  for (const l of r.limitations) p(`- ${l}`);
  p();
  return out.join('\n');
}

export async function writeVerification(paths: ArchivePaths, report: VerificationReport): Promise<{ markdown: string; json: string }> {
  const markdown = join(paths.report, 'verification.md');
  const json = join(paths.report, 'verification.json');
  await writeFileAtomic(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFileAtomic(markdown, renderMarkdown(report));
  return { markdown, json };
}
