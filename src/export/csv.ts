import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchivePaths, AttachmentRecord } from '../archive/layout.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { cmpDecimal, isZero } from '../util/decimal.ts';
import { numberText, parseLossless } from '../util/lossless-json.ts';

// Human-readable accountant copies, regenerated from everything in raw/ (not
// just this run). The raw JSON stays the source of truth; nothing here is
// read back by the tool.

type Rec = Record<string, unknown>;
type Kind = 'text' | 'number';
interface Column<T> {
  header: string;
  value: (row: T) => string;
  kind?: Kind;
}

export function get(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[key];
  }
  return cur;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : (numberText(v) ?? ''));
const money = (v: unknown): string => numberText(v) ?? '';
const field = (path: string) => (r: unknown) => str(get(r, path));
const amount = (path: string) => (r: unknown) => money(get(r, path));

/** RFC 4180 quoting, plus a guard so text cells can't run as spreadsheet formulas. */
export function csvCell(value: string, kind: Kind = 'text'): string {
  let v = value;
  if (kind === 'text' && /^[=+@\t\r]|^-(?![\d.])/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row), c.kind)).join(','));
  // BOM so Excel detects UTF-8 (accented names); CRLF per RFC 4180.
  return `﻿${lines.join('\r\n')}\r\n`;
}

const linkedIds = (type: string) => (r: unknown) =>
  ((get(r, 'LinkedTxn') as Rec[] | undefined) ?? [])
    .filter((l) => l.TxnType === type)
    .map((l) => str(l.TxnId))
    .join(' ');

const addressText = (path: string) => (r: unknown) => {
  const a = get(r, path) as Rec | undefined;
  if (!a) return '';
  return ['Line1', 'Line2', 'Line3', 'Line4', 'Line5', 'City', 'CountrySubDivisionCode', 'PostalCode', 'Country']
    .map((k) => str(a[k]))
    .filter(Boolean)
    .join(', ');
};

/** Paid / Partially paid / Open / Voided, derived from Balance vs TotalAmt. QBO marks voids with PrivateNote "Voided". */
export function invoiceStatus(inv: unknown): string {
  if (/^voided\b/i.test(str(get(inv, 'PrivateNote')))) return 'Voided';
  const total = money(get(inv, 'TotalAmt')) || '0';
  const balance = money(get(inv, 'Balance')) || '0';
  if (isZero(balance)) return isZero(total) ? 'Zero total' : 'Paid';
  return cmpDecimal(balance, total) === 0 ? 'Open' : 'Partially paid';
}

const meta = <T>(): Column<T>[] => [
  { header: 'Created', value: field('MetaData.CreateTime') },
  { header: 'LastUpdated', value: field('MetaData.LastUpdatedTime') },
];

const INVOICE_COLUMNS: Column<unknown>[] = [
  { header: 'Id', value: field('Id') },
  { header: 'DocNumber', value: field('DocNumber') },
  { header: 'TxnDate', value: field('TxnDate') },
  { header: 'DueDate', value: field('DueDate') },
  { header: 'CustomerId', value: field('CustomerRef.value') },
  { header: 'Customer', value: field('CustomerRef.name') },
  { header: 'Status', value: invoiceStatus },
  { header: 'Currency', value: field('CurrencyRef.value') },
  { header: 'TotalAmt', value: amount('TotalAmt'), kind: 'number' },
  { header: 'TotalTax', value: amount('TxnTaxDetail.TotalTax'), kind: 'number' },
  { header: 'Balance', value: amount('Balance'), kind: 'number' },
  { header: 'GlobalTaxCalculation', value: field('GlobalTaxCalculation') },
  { header: 'FromEstimateIds', value: linkedIds('Estimate') },
  { header: 'PaymentIds', value: linkedIds('Payment') },
  { header: 'EmailStatus', value: field('EmailStatus') },
  { header: 'CustomerMemo', value: field('CustomerMemo.value') },
  { header: 'PrivateNote', value: field('PrivateNote') },
  ...meta(),
];

interface LineRow {
  txn: unknown;
  line: Rec | undefined;
  type: string;
}

const lineField = (path: string) => (r: LineRow) => str(get(r.line, path));
const lineAmount = (path: string) => (r: LineRow) => money(get(r.line, path));

const INVOICE_LINE_COLUMNS: Column<LineRow>[] = [
  { header: 'InvoiceId', value: (r) => str(get(r.txn, 'Id')) },
  { header: 'DocNumber', value: (r) => str(get(r.txn, 'DocNumber')) },
  { header: 'TxnDate', value: (r) => str(get(r.txn, 'TxnDate')) },
  { header: 'Customer', value: (r) => str(get(r.txn, 'CustomerRef.name')) },
  { header: 'LineNum', value: lineField('LineNum') },
  { header: 'DetailType', value: lineField('DetailType') },
  { header: 'ItemId', value: lineField('SalesItemLineDetail.ItemRef.value') },
  { header: 'Item', value: lineField('SalesItemLineDetail.ItemRef.name') },
  { header: 'Description', value: lineField('Description') },
  { header: 'Qty', value: lineAmount('SalesItemLineDetail.Qty'), kind: 'number' },
  { header: 'UnitPrice', value: lineAmount('SalesItemLineDetail.UnitPrice'), kind: 'number' },
  { header: 'Amount', value: lineAmount('Amount'), kind: 'number' },
  { header: 'TaxCodeId', value: lineField('SalesItemLineDetail.TaxCodeRef.value') },
  { header: 'ServiceDate', value: lineField('SalesItemLineDetail.ServiceDate') },
];

const ESTIMATE_COLUMNS: Column<unknown>[] = [
  { header: 'Id', value: field('Id') },
  { header: 'DocNumber', value: field('DocNumber') },
  { header: 'TxnDate', value: field('TxnDate') },
  { header: 'ExpirationDate', value: field('ExpirationDate') },
  { header: 'CustomerId', value: field('CustomerRef.value') },
  { header: 'Customer', value: field('CustomerRef.name') },
  { header: 'Status', value: field('TxnStatus') },
  { header: 'AcceptedBy', value: field('AcceptedBy') },
  { header: 'AcceptedDate', value: field('AcceptedDate') },
  { header: 'Currency', value: field('CurrencyRef.value') },
  { header: 'TotalAmt', value: amount('TotalAmt'), kind: 'number' },
  { header: 'TotalTax', value: amount('TxnTaxDetail.TotalTax'), kind: 'number' },
  { header: 'ConvertedToInvoiceIds', value: linkedIds('Invoice') },
  { header: 'CustomerMemo', value: field('CustomerMemo.value') },
  { header: 'PrivateNote', value: field('PrivateNote') },
  ...meta(),
];

const payee = (r: LineRow, part: 'value' | 'name' | 'type'): string => {
  if (r.type === 'Purchase') return str(get(r.txn, `EntityRef.${part}`));
  return part === 'type' ? 'Vendor' : str(get(r.txn, `VendorRef.${part}`));
};

/** One row per expense line: Purchase (cash/cheque/credit card), Bill, VendorCredit. */
const EXPENSE_COLUMNS: Column<LineRow>[] = [
  { header: 'Type', value: (r) => r.type },
  { header: 'Id', value: (r) => str(get(r.txn, 'Id')) },
  { header: 'DocNumber', value: (r) => str(get(r.txn, 'DocNumber')) },
  { header: 'TxnDate', value: (r) => str(get(r.txn, 'TxnDate')) },
  { header: 'DueDate', value: (r) => str(get(r.txn, 'DueDate')) },
  { header: 'PayeeType', value: (r) => payee(r, 'type') },
  { header: 'PayeeId', value: (r) => payee(r, 'value') },
  { header: 'Payee', value: (r) => payee(r, 'name') },
  { header: 'PaymentType', value: (r) => str(get(r.txn, 'PaymentType')) },
  { header: 'IsCredit', value: (r) => str(get(r.txn, 'Credit')) },
  { header: 'PaidFromAccount', value: (r) => str(get(r.txn, 'AccountRef.name') ?? get(r.txn, 'APAccountRef.name')) },
  { header: 'Currency', value: (r) => str(get(r.txn, 'CurrencyRef.value')) },
  { header: 'TxnTotalAmt', value: (r) => money(get(r.txn, 'TotalAmt')), kind: 'number' },
  { header: 'TxnTotalTax', value: (r) => money(get(r.txn, 'TxnTaxDetail.TotalTax')), kind: 'number' },
  { header: 'TxnBalance', value: (r) => money(get(r.txn, 'Balance')), kind: 'number' },
  { header: 'GlobalTaxCalculation', value: (r) => str(get(r.txn, 'GlobalTaxCalculation')) },
  { header: 'LineNum', value: lineField('LineNum') },
  { header: 'LineDetailType', value: lineField('DetailType') },
  {
    header: 'CategoryOrItem',
    value: (r) => str(get(r.line, 'AccountBasedExpenseLineDetail.AccountRef.name') ?? get(r.line, 'ItemBasedExpenseLineDetail.ItemRef.name')),
  },
  { header: 'LineDescription', value: lineField('Description') },
  { header: 'LineAmount', value: lineAmount('Amount'), kind: 'number' },
  {
    header: 'LineTaxCodeId',
    value: (r) => str(get(r.line, 'AccountBasedExpenseLineDetail.TaxCodeRef.value') ?? get(r.line, 'ItemBasedExpenseLineDetail.TaxCodeRef.value')),
  },
  {
    header: 'LineCustomer',
    value: (r) => str(get(r.line, 'AccountBasedExpenseLineDetail.CustomerRef.name') ?? get(r.line, 'ItemBasedExpenseLineDetail.CustomerRef.name')),
  },
  {
    header: 'LineBillableStatus',
    value: (r) => str(get(r.line, 'AccountBasedExpenseLineDetail.BillableStatus') ?? get(r.line, 'ItemBasedExpenseLineDetail.BillableStatus')),
  },
  { header: 'PrivateNote', value: (r) => str(get(r.txn, 'PrivateNote')) },
];

const contactColumns = (): Column<unknown>[] => [
  { header: 'Id', value: field('Id') },
  { header: 'DisplayName', value: field('DisplayName') },
  { header: 'CompanyName', value: field('CompanyName') },
  { header: 'GivenName', value: field('GivenName') },
  { header: 'FamilyName', value: field('FamilyName') },
  { header: 'Email', value: field('PrimaryEmailAddr.Address') },
  { header: 'Phone', value: field('PrimaryPhone.FreeFormNumber') },
  { header: 'BillingAddress', value: addressText('BillAddr') },
  { header: 'Balance', value: amount('Balance'), kind: 'number' },
  { header: 'Currency', value: field('CurrencyRef.value') },
  { header: 'Active', value: field('Active') },
];

const CUSTOMER_COLUMNS: Column<unknown>[] = [
  ...contactColumns(),
  { header: 'ShippingAddress', value: addressText('ShipAddr') },
  { header: 'Taxable', value: field('Taxable') },
  { header: 'Notes', value: field('Notes') },
  ...meta(),
];

const VENDOR_COLUMNS: Column<unknown>[] = [
  ...contactColumns(),
  { header: 'AccountNumber', value: field('AcctNum') },
  { header: 'TermId', value: field('TermRef.value') },
  ...meta(),
];

const ITEM_COLUMNS: Column<unknown>[] = [
  { header: 'Id', value: field('Id') },
  { header: 'Name', value: field('Name') },
  { header: 'FullyQualifiedName', value: field('FullyQualifiedName') },
  { header: 'Sku', value: field('Sku') },
  { header: 'Type', value: field('Type') },
  { header: 'Active', value: field('Active') },
  { header: 'Description', value: field('Description') },
  { header: 'UnitPrice', value: amount('UnitPrice'), kind: 'number' },
  { header: 'PurchaseCost', value: amount('PurchaseCost'), kind: 'number' },
  { header: 'IncomeAccount', value: field('IncomeAccountRef.name') },
  { header: 'ExpenseAccount', value: field('ExpenseAccountRef.name') },
  { header: 'Taxable', value: field('Taxable') },
  { header: 'SalesTaxCodeId', value: field('SalesTaxCodeRef.value') },
  { header: 'PurchaseTaxCodeId', value: field('PurchaseTaxCodeRef.value') },
  ...meta(),
];

/** Every record in raw/<entity>/, sorted by TxnDate then numeric Id. */
export async function readRawRecords(paths: ArchivePaths, entity: string): Promise<Rec[]> {
  const dir = join(paths.raw, entity);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  const records: Rec[] = [];
  for (const f of files) records.push(parseLossless(await readFile(join(dir, f), 'utf8')) as Rec);
  return records.sort(
    (a, b) => str(a.TxnDate).localeCompare(str(b.TxnDate)) || str(a.Id).localeCompare(str(b.Id), 'en', { numeric: true }),
  );
}

const linesOf = (type: string, txns: Rec[]): LineRow[] =>
  txns.flatMap((txn): LineRow[] => {
    const lines = ((txn.Line as Rec[] | undefined) ?? []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
    return lines.length > 0 ? lines.map((line) => ({ txn, line, type })) : [{ txn, line: undefined, type }];
  });

export async function writeCsvs(paths: ArchivePaths): Promise<string[]> {
  const invoices = await readRawRecords(paths, 'Invoice');
  const expenses = [
    ...linesOf('Purchase', await readRawRecords(paths, 'Purchase')),
    ...linesOf('Bill', await readRawRecords(paths, 'Bill')),
    ...linesOf('VendorCredit', await readRawRecords(paths, 'VendorCredit')),
  ].sort((a, b) => str(get(a.txn, 'TxnDate')).localeCompare(str(get(b.txn, 'TxnDate'))));

  const outputs: Array<[string, string]> = [
    ['invoices.csv', toCsv(INVOICE_COLUMNS, invoices)],
    ['invoice_lines.csv', toCsv(INVOICE_LINE_COLUMNS, linesOf('Invoice', invoices).filter((r) => r.line))],
    ['estimates.csv', toCsv(ESTIMATE_COLUMNS, await readRawRecords(paths, 'Estimate'))],
    ['expenses.csv', toCsv(EXPENSE_COLUMNS, expenses)],
    ['customers.csv', toCsv(CUSTOMER_COLUMNS, await readRawRecords(paths, 'Customer'))],
    ['vendors.csv', toCsv(VENDOR_COLUMNS, await readRawRecords(paths, 'Vendor'))],
    ['items.csv', toCsv(ITEM_COLUMNS, await readRawRecords(paths, 'Item'))],
  ];
  for (const [name, body] of outputs) await writeFileAtomic(join(paths.csv, name), body);
  return outputs.map(([name]) => name);
}

/** "Invoice 1037 (#130)" using the archived transaction's DocNumber when there is one. */
async function linkLabel(paths: ArchivePaths, entityType: string, entityId: string): Promise<string> {
  const text = await readFile(paths.rawRecord(entityType, entityId), 'utf8').catch(() => undefined);
  const doc = text ? str((parseLossless(text) as Rec).DocNumber) : '';
  return `${entityType}${doc ? ` ${doc}` : ''} (#${entityId})`;
}

export async function writeAttachmentsCsv(paths: ArchivePaths, records: AttachmentRecord[]): Promise<string> {
  const rows = [];
  for (const r of records) {
    const labels = [];
    for (const l of r.linkedTo) labels.push(await linkLabel(paths, l.entityType, l.entityId));
    rows.push({ r, links: labels.join('; ') });
  }
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { header: 'AttachableId', value: ({ r }) => r.attachableId },
    { header: 'FileName', value: ({ r }) => r.fileName ?? '' },
    { header: 'Category', value: ({ r }) => r.category ?? '' },
    { header: 'Status', value: ({ r }) => r.status },
    { header: 'LinkedTo', value: ({ links }) => links },
    { header: 'Unlinked', value: ({ r }) => (r.status !== 'note-only' && r.linkedTo.length === 0 ? 'yes' : '') },
    { header: 'ContentType', value: ({ r }) => r.contentType ?? '' },
    { header: 'SizeBytes', value: ({ r }) => (r.sizeBytes === null ? '' : String(r.sizeBytes)), kind: 'number' },
    { header: 'SizeMatchesQbo', value: ({ r }) => (r.sizeMatches === null ? '' : String(r.sizeMatches)) },
    { header: 'SHA256', value: ({ r }) => r.sha256 ?? '' },
    { header: 'Path', value: ({ r }) => r.path ?? '' },
    { header: 'Error', value: ({ r }) => r.error ?? '' },
    { header: 'Note', value: ({ r }) => r.note ?? '' },
  ];
  await writeFileAtomic(join(paths.csv, 'attachments.csv'), toCsv(columns, rows));
  return 'attachments.csv';
}
