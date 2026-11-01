import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QboClient } from '../api/client.ts';
import { countRecords, fetchPage, isQueryRejected, MAX_PAGE_SIZE } from '../api/query.ts';
import { initArchive, safeSegment, type ArchivePaths } from '../archive/layout.ts';
import { QboApiError, UserFacingError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { acquireLock } from '../util/lockfile.ts';
import { stringifyLossless } from '../util/lossless-json.ts';
import { ENTITIES, queryVariants, type EntitySpec } from './entities.ts';
import { newEntityProgress, StateStore, type EntityProgress, type ExportState } from './state.ts';

export interface ExportOptions {
  client: QboClient;
  log: Logger;
  since?: string | null;
  /** Discard any unfinished run and start over. */
  fresh?: boolean;
  /** Restrict to these entity names. */
  only?: string[];
  pageSize?: number;
  /** Entities exported in parallel (requests are still capped by the client's throttle). */
  entityConcurrency?: number;
  now?: () => Date;
  onProgress?: (entity: string, progress: EntityProgress) => void;
}

export interface ExportRun {
  paths: ArchivePaths;
  state: ExportState;
  resumed: boolean;
  specs: EntitySpec[];
}

const DONE = new Set(['complete', 'skipped']);

/** Runs `fn` holding the archive's lock so two exports never write the same folder. */
export async function withArchiveLock<T>(outDir: string, fn: (paths: ArchivePaths) => Promise<T>): Promise<T> {
  const paths = await initArchive(outDir);
  const release = await acquireLock(paths.lock, { timeoutMs: 1000 }).catch(() => {
    throw new UserFacingError(`Another export is already running against ${outDir}.`);
  });
  try {
    return await fn(paths);
  } finally {
    await release();
  }
}

/** Exports every entity's records to raw/<Entity>/<Id>.json, resumably. Caller holds the archive lock. */
export async function exportRecords(paths: ArchivePaths, options: ExportOptions): Promise<ExportRun> {
  const now = options.now ?? (() => new Date());
  const since = options.since ?? null;
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const specs = selectSpecs(options.only);
  const store = new StateStore(paths.state);
  const previous = await store.load();
  if (previous && previous.realmId !== options.client.realmId) {
    throw new UserFacingError(
      `This archive belongs to company ${previous.realmId}, but you are connected to ${options.client.realmId}. Use a different --out folder.`,
    );
  }
  const resumable =
    previous &&
    !options.fresh &&
    previous.since === since &&
    specs.some((s) => !DONE.has(previous.entities[s.name]?.status ?? 'pending'));
  const state: ExportState = resumable
    ? previous
    : {
        version: 1,
        realmId: options.client.realmId,
        runId: randomUUID(),
        startedAt: now().toISOString(),
        finishedAt: null,
        since,
        entities: {},
      };
  if (resumable) {
    state.finishedAt = null;
    options.log.info({ runId: state.runId }, 'Resuming unfinished export');
  }
  for (const spec of specs) state.entities[spec.name] ??= newEntityProgress();
  await store.save(state);

  const ctx = { ...options, since, pageSize, paths, store, state, now };
  await pool(specs, options.entityConcurrency ?? 3, async (spec) => {
    const progress = state.entities[spec.name]!;
    if (DONE.has(progress.status)) return;
    try {
      await exportEntity(ctx, spec, progress);
    } catch (err) {
      progress.status = 'failed';
      progress.error = describeError(err);
      options.log.error({ entity: spec.name, error: progress.error }, 'Entity export failed');
      await store.save(state);
    }
    options.onProgress?.(spec.name, progress);
  });

  if (specs.every((s) => DONE.has(state.entities[s.name]!.status))) state.finishedAt = now().toISOString();
  await store.save(state);
  return { paths, state, resumed: !!resumable, specs };
}

interface Ctx extends ExportOptions {
  since: string | null;
  pageSize: number;
  paths: ArchivePaths;
  store: StateStore;
  state: ExportState;
  now: () => Date;
}

async function exportEntity(ctx: Ctx, spec: EntitySpec, p: EntityProgress): Promise<void> {
  const { client, log, store, state } = ctx;
  const strategies = queryVariants(spec, ctx.since);
  if (p.status === 'pending' || p.status === 'failed') {
    if (p.status === 'pending' || (p.part === 0 && p.nextStartPosition === 1)) await store.resetSeen(spec.name);
    p.error = undefined;
  }
  p.status = 'in_progress';
  await store.save(state);

  for (;;) {
    const parts = strategies[p.strategy]!;
    const variant = parts[p.part]!;
    let records: unknown[];
    try {
      records = await fetchPage(client, spec.name, variant, p.nextStartPosition, ctx.pageSize);
    } catch (err) {
      const atStart = p.part === 0 && p.nextStartPosition === 1;
      if (atStart && isQueryRejected(err) && p.strategy < strategies.length - 1) {
        p.strategy++;
        log.info({ entity: spec.name, strategy: p.strategy }, 'Query form rejected; trying a simpler one');
        continue;
      }
      if (atStart && spec.optional && err instanceof QboApiError && err.status >= 400 && err.status < 500) {
        p.status = 'skipped';
        p.note = `Not available for this company (${describeError(err)}). This is expected on QuickBooks Essentials.`;
        await store.save(state);
        return;
      }
      throw err;
    }

    const ids: string[] = [];
    for (const record of records) {
      const id = recordId(spec.name, record);
      await writeFileAtomic(ctx.paths.rawRecord(spec.name, id), `${stringifyLossless(record, 2)}\n`);
      ids.push(safeSegment(id)); // same spelling as the file name, for findNotReturned
    }
    await store.appendSeen(spec.name, ids);
    p.fetched += records.length;

    if (records.length < ctx.pageSize) {
      if (p.part + 1 < parts.length) {
        p.part++;
        p.nextStartPosition = 1;
        await store.save(state);
        continue;
      }
      p.nextStartPosition += records.length;
      break;
    }
    p.nextStartPosition += records.length;
    await store.save(state);
    log.debug({ entity: spec.name, fetched: p.fetched }, 'Page saved');
  }

  try {
    let total: number | null = 0;
    for (const part of strategies[p.strategy]!) {
      const n = await countRecords(client, spec.name, part.where);
      total = n === null || total === null ? null : total + n;
    }
    p.qboCount = total;
    if (total === null) p.note = 'QBO does not report a count for this entity.';
  } catch (err) {
    p.qboCount = null;
    p.note = `QBO count unavailable: ${describeError(err)}`;
  }
  // A page re-fetched after a crash is counted twice above; the seen-set is exact.
  const seen = await store.readSeen(spec.name);
  p.fetched = seen.size;
  p.notReturnedByQbo = ctx.since ? [] : await findNotReturned(ctx, spec.name, seen);
  p.status = 'complete';
  p.completedAt = ctx.now().toISOString();
  await store.save(state);
  log.info({ entity: spec.name, fetched: p.fetched, qboCount: p.qboCount }, 'Entity exported');
}

/** IDs with a raw file from an earlier run that QBO did not return this time. */
async function findNotReturned(ctx: Ctx, entity: string, seen: Set<string>): Promise<string[]> {
  const files = await readdir(join(ctx.paths.raw, entity)).catch(() => [] as string[]);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => !seen.has(id))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** QBO Id, or the entity name for singletons like Preferences that may lack one. */
export function recordId(entity: string, record: unknown): string {
  const id = (record as { Id?: unknown }).Id;
  return typeof id === 'string' && id.length > 0 ? id : entity;
}

function selectSpecs(only: string[] | undefined): EntitySpec[] {
  if (!only || only.length === 0) return [...ENTITIES];
  const wanted = new Map(only.map((n) => [n.toLowerCase(), n]));
  const specs = ENTITIES.filter((s) => wanted.delete(s.name.toLowerCase()));
  if (wanted.size > 0) throw new UserFacingError(`Unknown entity: ${[...wanted.values()].join(', ')}`);
  return specs;
}

function describeError(err: unknown): string {
  if (err instanceof QboApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]!);
  });
  await Promise.all(runners);
}
