import { join } from 'node:path';
import type { QboClient } from '../api/client.ts';
import type { ArchivePaths } from '../archive/layout.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { addDecimal } from '../util/decimal.ts';
import type { FiscalYear } from './archive-totals.ts';

// Thin readers for the QBO Reports API. Report cells are strings already
// ("1234.56", or "" for zero), so amounts stay exact.

interface Cell {
  value?: string;
  id?: string;
}
interface ReportRow {
  type?: string;
  group?: string;
  ColData?: Cell[];
  Header?: { ColData?: Cell[] };
  Summary?: { ColData?: Cell[] };
  Rows?: { Row?: ReportRow[] };
}
interface Report {
  Header?: Record<string, unknown>;
  Columns?: { Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> };
  Rows?: { Row?: ReportRow[] };
}

const money = (v: string | undefined): string => (v && v.trim() !== '' ? v.trim() : '0');

/** Fetches a report and keeps its raw JSON under report/reports-raw/. */
async function fetchReport(client: QboClient, paths: ArchivePaths, name: string, params: Record<string, string>): Promise<Report> {
  const { body, text } = await client.get(`reports/${name}`, params);
  const suffix = Object.values(params).join('_').replace(/[^\w-]/g, '');
  await writeFileAtomic(join(paths.reportsRaw, `${name}_${suffix}.json`), text);
  return body as Report;
}

export interface PnlTotals {
  income: string;
  otherIncome: string;
  cogs: string;
  expenses: string;
  otherExpenses: string;
  netIncome: string;
  /** income + otherIncome */
  totalIncome: string;
  /** cogs + expenses + otherExpenses */
  totalExpenses: string;
  basis: string | null;
}

export function parsePnl(report: Report): PnlTotals {
  const groupTotal = (group: string): string => {
    const row = report.Rows?.Row?.find((r) => r.group === group);
    const cells = row?.Summary?.ColData ?? [];
    return money(cells[cells.length - 1]?.value);
  };
  const income = groupTotal('Income');
  const otherIncome = groupTotal('OtherIncome');
  const cogs = groupTotal('COGS');
  const expenses = groupTotal('Expenses');
  const otherExpenses = groupTotal('OtherExpenses');
  return {
    income,
    otherIncome,
    cogs,
    expenses,
    otherExpenses,
    netIncome: groupTotal('NetIncome'),
    totalIncome: addDecimal(income, otherIncome),
    totalExpenses: addDecimal(cogs, expenses, otherExpenses),
    basis: typeof report.Header?.ReportBasis === 'string' ? report.Header.ReportBasis : null,
  };
}

export async function fetchPnl(client: QboClient, paths: ArchivePaths, fy: FiscalYear, basis: string): Promise<PnlTotals> {
  return parsePnl(
    await fetchReport(client, paths, 'ProfitAndLoss', { start_date: fy.start, end_date: fy.end, accounting_method: basis }),
  );
}

export type PnlSection = 'Income' | 'OtherIncome' | 'COGS' | 'Expenses' | 'OtherExpenses';

export interface ReportTxn {
  type: string;
  id: string;
}

export interface ReportTxnRow extends ReportTxn {
  /** P&L section the row sits in (null if it can't be told). */
  section: PnlSection | null;
  amount: string;
}

// Real reports label sections by header text ("Cost of Goods Sold", nested
// under "Ordinary Income/Expenses"); some carry a `group` attribute instead.
const SECTION_BY_HEADER: Record<string, PnlSection> = {
  income: 'Income',
  'other income': 'OtherIncome',
  'cost of goods sold': 'COGS',
  'cost of sales': 'COGS',
  expenses: 'Expenses',
  'other expense': 'OtherExpenses',
  'other expenses': 'OtherExpenses',
};
const SECTION_GROUPS = new Set<string>(['Income', 'OtherIncome', 'COGS', 'Expenses', 'OtherExpenses']);

function columnIndex(report: Report, key: string, title: RegExp, fallback: number): number {
  const columns = report.Columns?.Column ?? [];
  let idx = columns.findIndex((c) => c.MetaData?.some((m) => m.Name === 'ColKey' && m.Value === key));
  if (idx < 0) idx = columns.findIndex((c) => title.test(c.ColTitle ?? ''));
  return idx < 0 ? fallback : idx;
}

/** Every transaction row in a P&L Detail report, with its section and amount. */
export function parsePnlDetailRows(report: Report): ReportTxnRow[] {
  const typeIdx = columnIndex(report, 'txn_type', /transaction type/i, 1);
  const amountIdx = columnIndex(report, 'subt_nat_amount', /^amount$/i, -1);
  const out: ReportTxnRow[] = [];
  const walk = (rows: ReportRow[] | undefined, section: PnlSection | null) => {
    for (const row of rows ?? []) {
      let here = section;
      if (!here) {
        const header = row.Header?.ColData?.[0]?.value?.trim().toLowerCase();
        here = (row.group && SECTION_GROUPS.has(row.group) ? (row.group as PnlSection) : null) ?? (header ? SECTION_BY_HEADER[header] ?? null : null);
      }
      const cell = row.ColData?.[typeIdx];
      if (cell?.id && cell.value) {
        const cells = row.ColData ?? [];
        out.push({ type: cell.value, id: cell.id, section: here, amount: money(cells[amountIdx < 0 ? cells.length - 1 : amountIdx]?.value) });
      }
      walk(row.Rows?.Row, here);
    }
  };
  walk(report.Rows?.Row, null);
  return out;
}

/** Distinct transactions (type + id) listed in a P&L Detail report. */
export function parsePnlDetailTxns(report: Report): ReportTxn[] {
  const out = new Map<string, ReportTxn>();
  for (const r of parsePnlDetailRows(report)) out.set(`${r.type}/${r.id}`, { type: r.type, id: r.id });
  return [...out.values()];
}

const SALES_TYPES = new Set(['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt']);

/** Cost of goods sold that QBO booked through sales of inventory items. */
export function inventoryCostOfSales(rows: ReportTxnRow[]): string {
  const amounts = rows.filter((r) => r.section === 'COGS' && SALES_TYPES.has(entityForTxnType(r.type) ?? '')).map((r) => r.amount);
  return addDecimal('0', ...amounts);
}

export async function fetchPnlDetailRows(client: QboClient, paths: ArchivePaths, fy: FiscalYear, basis: string): Promise<ReportTxnRow[]> {
  return parsePnlDetailRows(
    await fetchReport(client, paths, 'ProfitAndLossDetail', { start_date: fy.start, end_date: fy.end, accounting_method: basis }),
  );
}

/** Grand total of an A/R Aging Summary report. */
export function parseAgedReceivablesTotal(report: Report): string {
  const rows = report.Rows?.Row ?? [];
  const grand = rows.find((r) => r.group === 'GrandTotal') ?? rows[rows.length - 1];
  const cells = grand?.Summary?.ColData ?? grand?.ColData ?? [];
  return money(cells[cells.length - 1]?.value);
}

export async function fetchAgedReceivablesTotal(client: QboClient, paths: ArchivePaths, reportDate: string): Promise<string> {
  return parseAgedReceivablesTotal(await fetchReport(client, paths, 'AgedReceivables', { report_date: reportDate }));
}

/** Report "Transaction Type" labels -> archive entity folder. US and Canadian spellings. */
const TXN_TYPE_TO_ENTITY: Record<string, string> = {
  invoice: 'Invoice',
  'sales receipt': 'SalesReceipt',
  'credit memo': 'CreditMemo',
  refund: 'RefundReceipt',
  'refund receipt': 'RefundReceipt',
  payment: 'Payment',
  deposit: 'Deposit',
  expense: 'Purchase',
  'cash expense': 'Purchase',
  check: 'Purchase',
  cheque: 'Purchase',
  'cheque expense': 'Purchase',
  'credit card expense': 'Purchase',
  'credit card credit': 'Purchase',
  bill: 'Bill',
  'vendor credit': 'VendorCredit',
  'supplier credit': 'VendorCredit',
  'bill payment': 'BillPayment',
  'bill payment (check)': 'BillPayment',
  'bill payment (cheque)': 'BillPayment',
  'bill payment (credit card)': 'BillPayment',
  'journal entry': 'JournalEntry',
  transfer: 'Transfer',
  'time charge': 'TimeActivity',
  'credit card payment': 'CreditCardPayment',
};

export function entityForTxnType(type: string): string | undefined {
  return TXN_TYPE_TO_ENTITY[type.trim().toLowerCase()];
}
