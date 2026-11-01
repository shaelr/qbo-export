import { QboApiError } from '../errors.ts';
import { numberText } from '../util/lossless-json.ts';
import type { QboClient } from './client.ts';

export const MAX_PAGE_SIZE = 1000;

/** One way of phrasing an entity's query; exporters fall back through these. */
export interface QueryVariant {
  where: string[];
  orderBy: boolean;
}

export function buildSelect(entity: string, variant: QueryVariant, startPosition: number, maxResults: number): string {
  return (
    `SELECT * FROM ${entity}${whereClause(variant.where)}${variant.orderBy ? ' ORDERBY Id' : ''}` +
    ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`
  );
}

export function buildCount(entity: string, where: string[]): string {
  return `SELECT COUNT(*) FROM ${entity}${whereClause(where)}`;
}

function whereClause(where: string[]): string {
  return where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
}

/** Records of `entity` from a /query response body (empty when QBO omits the key). */
export function extractRecords(body: unknown, entity: string): unknown[] {
  const qr = (body as { QueryResponse?: Record<string, unknown> } | undefined)?.QueryResponse;
  const list = qr?.[entity];
  return Array.isArray(list) ? list : [];
}

export async function fetchPage(
  client: QboClient,
  entity: string,
  variant: QueryVariant,
  startPosition: number,
  pageSize: number,
): Promise<unknown[]> {
  const { body } = await client.get('query', { query: buildSelect(entity, variant, startPosition, pageSize) });
  return extractRecords(body, entity);
}

/**
 * QBO's own count for the same filter; used to verify completeness. Null when
 * QBO gives no totalCount (it omits it for singletons such as CompanyInfo).
 */
export async function countRecords(client: QboClient, entity: string, where: string[]): Promise<number | null> {
  const { body } = await client.get('query', { query: buildCount(entity, where) });
  const total = numberText((body as { QueryResponse?: { totalCount?: unknown } }).QueryResponse?.totalCount);
  return total === undefined ? null : Number(total);
}

/** True when QBO rejected the query text itself (parser/validation fault), not the request. */
export function isQueryRejected(err: unknown): boolean {
  if (!(err instanceof QboApiError) || err.status !== 400) return false;
  return err.faults.some(
    (f) => f.code === '4000' || f.code === '4001' || /Query(Parser|Validation)Error|not queryable|unsupported/i.test(`${f.message} ${f.detail}`),
  );
}
