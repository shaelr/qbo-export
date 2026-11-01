import type { ArchivePaths } from '../archive/layout.ts';
import { get, readRawRecords } from '../export/csv.ts';
import { fromUnits, toUnits } from '../util/decimal.ts';
import { numberText } from '../util/lossless-json.ts';

// Totals computed from the archive's raw records, for comparison with QBO's
// own reports. All arithmetic is exact (BigInt fixed point via decimal.ts).

type Rec = Record<string, unknown>;

export interface FiscalYear {
  label: string;
  /** Inclusive ISO dates. */
  start: string;
  end: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function monthNumber(name: string | null | undefined): number {
  const i = MONTHS.indexOf((name ?? '').trim().toLowerCase());
  return i >= 0 ? i + 1 : 1;
}

const pad = (n: number) => String(n).padStart(2, '0');

function fyStartYear(date: string, startMonth: number): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= startMonth ? year : year - 1;
}

/** Every fiscal year from the one containing `firstDate` through the one containing `today`. */
export function fiscalYears(startMonthName: string | null | undefined, firstDate: string, today: string): FiscalYear[] {
  const m = monthNumber(startMonthName);
  const years: FiscalYear[] = [];
  for (let y = fyStartYear(firstDate, m); y <= fyStartYear(today, m); y++) {
    const end = new Date(Date.UTC(y + 1, m - 1, 1) - 86_400_000);
    years.push({
      label: m === 1 ? String(y) : `FY ${y}-${pad((y + 1) % 100)}`,
      start: `${y}-${pad(m)}-01`,
      end: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
    });
  }
  return years;
}

const units = (v: unknown): bigint => {
  const t = numberText(v);
  return t === undefined || t === '' ? 0n : toUnits(t);
};

/** TotalAmt minus sales tax: correct for both tax-exclusive and tax-inclusive entry. */
export const netOfTax = (txn: Rec): bigint => units(txn.TotalAmt) - units(get(txn, 'TxnTaxDetail.TotalTax'));

export interface IncomeTotals {
  invoices: string;
  salesReceipts: string;
  creditMemos: string;
  refundReceipts: string;
  /** invoices + salesReceipts - creditMemos - refundReceipts */
  total: string;
  adjustments: {
    /** Net credits to income accounts made by journal entries. */
    journalEntries: string;
    /** Deposit lines posted straight to income accounts (not customer payments). */
    deposits: string;
    /** Expense/bill lines coded to an income account, which QBO shows as negative income. */
    expenseLines: string;
  };
}

export interface ExpenseTotals {
  /** Cash, cheque and credit-card expenses, net of credit-card credits. */
  purchases: string;
  bills: string;
  vendorCredits: string;
  /** purchases + bills - vendorCredits */
  total: string;
  adjustments: {
    /** Net debits to expense/COGS accounts made by journal entries. */
    journalEntries: string;
    /** Deposit lines posted to expense accounts (e.g. refunds from vendors), which reduce expenses. */
    deposits: string;
    /** Expense lines posted to balance-sheet accounts (equipment, inventory, loans, owner draws), which are not P&L expenses. */
    balanceSheetLines: string;
    /** Expense lines coded to an income account: not an expense in the P&L (see income.adjustments.expenseLines). */
    incomeAccountLines: string;
    /**
     * Cost of goods sold booked by sales of inventory items. The archive has no
     * inventory cost history, so this is filled in from QBO's P&L Detail report.
     */
    inventoryCostOfSales: string;
  };
}

export interface YearTotals {
  fy: FiscalYear;
  transactions: number;
  income: IncomeTotals;
  expenses: ExpenseTotals;
}

interface Bucket {
  n: number;
  inv: bigint;
  sr: bigint;
  cm: bigint;
  rr: bigint;
  incJe: bigint;
  incDep: bigint;
  incExp: bigint;
  pur: bigint;
  bill: bigint;
  vc: bigint;
  expJe: bigint;
  expDep: bigint;
  expBs: bigint;
  expInc: bigint;
}

const emptyBucket = (): Bucket => ({ n: 0, inv: 0n, sr: 0n, cm: 0n, rr: 0n, incJe: 0n, incDep: 0n, incExp: 0n, pur: 0n, bill: 0n, vc: 0n, expJe: 0n, expDep: 0n, expBs: 0n, expInc: 0n });

/** Account Id -> Classification (Revenue, Expense, Asset, Liability, Equity). */
async function accountClasses(paths: ArchivePaths): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const a of await readRawRecords(paths, 'Account')) map.set(String(a.Id), String(a.Classification ?? ''));
  return map;
}

const SALES = ['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'];
const EXPENSES = ['Purchase', 'Bill', 'VendorCredit'];

export async function earliestTxnDate(paths: ArchivePaths): Promise<string | null> {
  let first: string | null = null;
  for (const entity of [...SALES, ...EXPENSES, 'JournalEntry', 'Deposit']) {
    for (const r of await readRawRecords(paths, entity)) {
      const d = typeof r.TxnDate === 'string' ? r.TxnDate : null;
      if (d && (!first || d < first)) first = d;
    }
  }
  return first;
}

/**
 * Item Id -> the account a purchase of that item posts to: the inventory
 * asset account for inventory items, otherwise the item's expense account.
 */
async function itemPurchaseAccounts(paths: ArchivePaths): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const i of await readRawRecords(paths, 'Item')) {
    const acct = i.Type === 'Inventory' ? get(i, 'AssetAccountRef.value') : get(i, 'ExpenseAccountRef.value');
    if (typeof acct === 'string') map.set(String(i.Id), acct);
  }
  return map;
}

export async function computeYearTotals(paths: ArchivePaths, years: FiscalYear[]): Promise<YearTotals[]> {
  const classes = await accountClasses(paths);
  const itemAccounts = await itemPurchaseAccounts(paths);
  const buckets = years.map(emptyBucket);
  const bucketFor = (txn: Rec): Bucket | undefined => {
    const d = typeof txn.TxnDate === 'string' ? txn.TxnDate : '';
    const i = years.findIndex((y) => d >= y.start && d <= y.end);
    return i >= 0 ? buckets[i] : undefined;
  };
  const each = async (entity: string, fn: (b: Bucket, txn: Rec) => void) => {
    for (const txn of await readRawRecords(paths, entity)) {
      const b = bucketFor(txn);
      if (b) {
        b.n++;
        fn(b, txn);
      }
    }
  };
  const lines = (txn: Rec) => (txn.Line as Rec[] | undefined) ?? [];

  await each('Invoice', (b, t) => (b.inv += netOfTax(t)));
  await each('SalesReceipt', (b, t) => (b.sr += netOfTax(t)));
  await each('CreditMemo', (b, t) => (b.cm += netOfTax(t)));
  await each('RefundReceipt', (b, t) => (b.rr += netOfTax(t)));

  /** Expense-transaction line amounts by where they really post: balance sheet, or an income account. */
  const nonExpenseLines = (t: Rec): { balanceSheet: bigint; income: bigint } => {
    let balanceSheet = 0n;
    let income = 0n;
    for (const l of lines(t)) {
      const acctRef = get(l, 'AccountBasedExpenseLineDetail.AccountRef.value');
      const itemRef = get(l, 'ItemBasedExpenseLineDetail.ItemRef.value');
      const acct = typeof acctRef === 'string' ? acctRef : typeof itemRef === 'string' ? itemAccounts.get(itemRef) : undefined;
      const cls = acct ? classes.get(acct) : undefined;
      if (cls === 'Revenue') income += units(l.Amount);
      else if (cls && cls !== 'Expense') balanceSheet += units(l.Amount);
    }
    return { balanceSheet, income };
  };
  // sign: +1 when the transaction adds to expenses, -1 when it reduces them.
  const expenseTxn = (b: Bucket, t: Rec, sign: bigint) => {
    const { balanceSheet, income } = nonExpenseLines(t);
    b.expBs -= sign * balanceSheet;
    b.expInc -= sign * income;
    b.incExp -= sign * income; // a cost coded to an income account lowers income
  };
  await each('Purchase', (b, t) => {
    const sign = t.Credit === true ? -1n : 1n; // credit-card credits reduce expenses
    b.pur += sign * netOfTax(t);
    expenseTxn(b, t, sign);
  });
  await each('Bill', (b, t) => {
    b.bill += netOfTax(t);
    expenseTxn(b, t, 1n);
  });
  await each('VendorCredit', (b, t) => {
    b.vc += netOfTax(t);
    expenseTxn(b, t, -1n);
  });

  await each('JournalEntry', (b, t) => {
    for (const l of lines(t)) {
      const acct = get(l, 'JournalEntryLineDetail.AccountRef.value');
      const cls = typeof acct === 'string' ? classes.get(acct) : undefined;
      const debit = get(l, 'JournalEntryLineDetail.PostingType') === 'Debit';
      const amt = units(l.Amount);
      if (cls === 'Revenue') b.incJe += debit ? -amt : amt;
      if (cls === 'Expense') b.expJe += debit ? amt : -amt;
    }
  });
  await each('Deposit', (b, t) => {
    for (const l of lines(t)) {
      if (Array.isArray(l.LinkedTxn) && l.LinkedTxn.length > 0) continue; // customer payments being banked
      const acct = get(l, 'DepositLineDetail.AccountRef.value');
      const cls = typeof acct === 'string' ? classes.get(acct) : undefined;
      if (cls === 'Revenue') b.incDep += units(l.Amount);
      if (cls === 'Expense') b.expDep -= units(l.Amount);
    }
  });

  return years.map((fy, i) => {
    const b = buckets[i]!;
    return {
      fy,
      transactions: b.n,
      income: {
        invoices: fromUnits(b.inv),
        salesReceipts: fromUnits(b.sr),
        creditMemos: fromUnits(b.cm),
        refundReceipts: fromUnits(b.rr),
        total: fromUnits(b.inv + b.sr - b.cm - b.rr),
        adjustments: { journalEntries: fromUnits(b.incJe), deposits: fromUnits(b.incDep), expenseLines: fromUnits(b.incExp) },
      },
      expenses: {
        purchases: fromUnits(b.pur),
        bills: fromUnits(b.bill),
        vendorCredits: fromUnits(b.vc),
        total: fromUnits(b.pur + b.bill - b.vc),
        adjustments: {
          journalEntries: fromUnits(b.expJe),
          deposits: fromUnits(b.expDep),
          balanceSheetLines: fromUnits(b.expBs),
          incomeAccountLines: fromUnits(b.expInc),
          inventoryCostOfSales: '0.00',
        },
      },
    };
  });
}

export interface OpenReceivables {
  openInvoices: number;
  invoiceBalances: string;
  unappliedCredits: string;
  unappliedPayments: string;
  /** invoiceBalances - unappliedCredits - unappliedPayments */
  total: string;
}

/** What the archive says is owed to you right now. */
export async function computeOpenReceivables(paths: ArchivePaths): Promise<OpenReceivables> {
  let inv = 0n;
  let open = 0;
  for (const i of await readRawRecords(paths, 'Invoice')) {
    const bal = units(i.Balance);
    if (bal !== 0n) open++;
    inv += bal;
  }
  let cm = 0n;
  for (const c of await readRawRecords(paths, 'CreditMemo')) cm += units(c.RemainingCredit);
  let pay = 0n;
  for (const p of await readRawRecords(paths, 'Payment')) pay += units(p.UnappliedAmt);
  return {
    openInvoices: open,
    invoiceBalances: fromUnits(inv),
    unappliedCredits: fromUnits(cm),
    unappliedPayments: fromUnits(pay),
    total: fromUnits(inv - cm - pay),
  };
}
