import type { QueryVariant } from '../api/query.ts';
import { UserFacingError } from '../errors.ts';

export interface EntitySpec {
  name: string;
  /** Has an Active flag; QBO hides inactive records unless asked. */
  hasActive?: boolean;
  /** Supports the MetaData.LastUpdatedTime filter for --since runs (default true). */
  incremental?: boolean;
  /** May be unavailable on some plans (e.g. Essentials); failures become "skipped". */
  optional?: boolean;
}

export const ENTITIES: readonly EntitySpec[] = [
  // Company
  { name: 'CompanyInfo', incremental: false },
  { name: 'Preferences', incremental: false },
  // Lists (include inactive: old transactions reference them)
  { name: 'Account', hasActive: true },
  { name: 'Customer', hasActive: true },
  { name: 'Vendor', hasActive: true },
  { name: 'Employee', hasActive: true, optional: true },
  { name: 'Item', hasActive: true },
  { name: 'Term', hasActive: true },
  { name: 'PaymentMethod', hasActive: true },
  { name: 'Class', hasActive: true, optional: true },
  { name: 'Department', hasActive: true, optional: true },
  { name: 'TaxCode', hasActive: true, incremental: false },
  { name: 'TaxRate', hasActive: true, incremental: false },
  { name: 'TaxAgency', incremental: false },
  // Sales
  { name: 'Invoice' },
  { name: 'CreditMemo' },
  { name: 'Estimate' },
  { name: 'Payment' },
  { name: 'SalesReceipt' },
  { name: 'RefundReceipt' },
  // Expenses
  { name: 'Purchase' },
  { name: 'Bill' },
  { name: 'BillPayment' },
  { name: 'VendorCredit' },
  { name: 'PurchaseOrder', optional: true },
  { name: 'CreditCardPayment', optional: true },
  // Banking and general ledger
  { name: 'Deposit' },
  { name: 'Transfer' },
  { name: 'JournalEntry' },
  { name: 'TimeActivity', optional: true },
  // Attachment metadata, linked or not (Receipts-inbox items have no AttachableRef).
  // The files themselves are downloaded afterwards by attachments.ts.
  { name: 'Attachable' },
];

/** Accepts YYYY-MM-DD or a full ISO 8601 timestamp with offset. */
export function validateSince(since: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(since) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(since)) {
    if (!Number.isNaN(Date.parse(since))) return since;
  }
  throw new UserFacingError(`--since must be YYYY-MM-DD or an ISO timestamp like 2025-01-01T00:00:00-05:00 (got "${since}").`);
}

/**
 * Query phrasings to try, best first. If QBO rejects one (some entities don't
 * accept ORDERBY or an Active filter), the exporter moves to the next.
 * Without an Active filter we query active and inactive records separately.
 */
export function queryVariants(spec: EntitySpec, since: string | null): QueryVariant[][] {
  const sinceClause = since && spec.incremental !== false ? [`MetaData.LastUpdatedTime >= '${since}'`] : [];
  const one = (where: string[], orderBy: boolean): QueryVariant[] => [{ where: [...where, ...sinceClause], orderBy }];
  if (!spec.hasActive) return [one([], true), one([], false)];
  const both = 'Active IN (true, false)';
  return [
    one([both], true),
    one([both], false),
    [...one(['Active = true'], true), ...one(['Active = false'], true)],
    [...one(['Active = true'], false), ...one(['Active = false'], false)],
  ];
}
