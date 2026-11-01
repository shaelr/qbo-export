import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QboClient } from '../api/client.ts';
import type { ArchivePaths } from '../archive/layout.ts';
import { QboApiError } from '../errors.ts';
import { writeFileAtomic } from '../util/atomic.ts';

// Deleted records can't be queried. The Change Data Capture (CDC) feed is the
// only API that reports deletions, and only for the last 30 days. Every
// deletion seen is accumulated in state/deletions.json so the history grows
// with each run.

export const CDC_WINDOW_DAYS = 30;

// TaxAgency is left out: the CDC feed rejects it (fault 4001), which fails the
// whole batch.
export const CDC_ENTITIES = [
  'Account', 'Customer', 'Vendor', 'Employee', 'Item', 'Term', 'PaymentMethod', 'Class', 'Department',
  'Invoice', 'CreditMemo', 'Estimate', 'Payment', 'SalesReceipt', 'RefundReceipt',
  'Purchase', 'Bill', 'BillPayment', 'VendorCredit', 'PurchaseOrder',
  'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity',
];

export interface Deletion {
  entity: string;
  id: string;
  /** When QBO says it was deleted (MetaData.LastUpdatedTime of the tombstone). */
  deletedAt: string | null;
  /** First export run that saw this deletion. */
  firstSeen: string;
  /** Whether raw/<Entity>/<Id>.json exists, i.e. the archive kept a copy. */
  archived: boolean;
}

export interface CdcResult {
  changedSince: string;
  /** All deletions known to this archive (accumulated across runs). */
  deletions: Deletion[];
  /** Deletions first seen in this run. */
  newlySeen: number;
  unavailable: Array<{ entity: string; reason: string }>;
}

type Tombstone = { entity: string; id: string; deletedAt: string | null };

export function parseCdc(body: unknown): Tombstone[] {
  const out: Tombstone[] = [];
  const responses = (body as { CDCResponse?: Array<{ QueryResponse?: Array<Record<string, unknown>> }> }).CDCResponse ?? [];
  for (const r of responses) {
    for (const qr of r.QueryResponse ?? []) {
      for (const [entity, list] of Object.entries(qr)) {
        if (!Array.isArray(list)) continue;
        for (const obj of list as Array<{ Id?: string; status?: string; MetaData?: { LastUpdatedTime?: string } }>) {
          if (obj.status === 'Deleted' && obj.Id) out.push({ entity, id: obj.Id, deletedAt: obj.MetaData?.LastUpdatedTime ?? null });
        }
      }
    }
  }
  return out;
}

export async function checkDeletions(client: QboClient, paths: ArchivePaths, now: Date): Promise<CdcResult> {
  // A minute inside the window, since QBO rejects changedSince older than 30 days.
  const changedSince = new Date(now.getTime() - CDC_WINDOW_DAYS * 86_400_000 + 60_000).toISOString();
  const unavailable: CdcResult['unavailable'] = [];
  let tombstones: Tombstone[] = [];
  try {
    tombstones = parseCdc((await client.get('cdc', { entities: CDC_ENTITIES.join(','), changedSince })).body);
  } catch (err) {
    if (!(err instanceof QboApiError && err.status === 400)) throw err;
    // Some entity in the batch isn't supported for this company; ask one at a time.
    for (const entity of CDC_ENTITIES) {
      try {
        tombstones.push(...parseCdc((await client.get('cdc', { entities: entity, changedSince })).body));
      } catch (e) {
        if (!(e instanceof QboApiError && e.status === 400)) throw e;
        unavailable.push({ entity, reason: e.message });
      }
    }
  }

  const file = join(paths.root, 'state', 'deletions.json');
  const known = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, Deletion>;
  let newlySeen = 0;
  for (const t of tombstones) {
    const key = `${t.entity}/${t.id}`;
    if (!known[key]) {
      newlySeen++;
      known[key] = { ...t, firstSeen: now.toISOString(), archived: false };
    }
  }
  for (const d of Object.values(known)) {
    d.archived = await readFile(paths.rawRecord(d.entity, d.id)).then(
      () => true,
      () => false,
    );
  }
  await writeFileAtomic(file, `${JSON.stringify(known, null, 2)}\n`);
  const deletions = Object.values(known).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  return { changedSince, deletions, newlySeen, unavailable };
}
