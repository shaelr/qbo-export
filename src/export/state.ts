import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../util/atomic.ts';

export type EntityStatus = 'pending' | 'in_progress' | 'complete' | 'skipped' | 'failed';

export interface EntityProgress {
  status: EntityStatus;
  /** Index into queryVariants(): which phrasing QBO accepted. */
  strategy: number;
  /** Which sub-query of the strategy (e.g. Active=true, then Active=false). */
  part: number;
  /** STARTPOSITION of the next page to fetch within the current part. */
  nextStartPosition: number;
  /** Records written in this run. */
  fetched: number;
  qboCount: number | null;
  /** IDs in raw/ that QBO no longer returned on a full run (likely deleted in QBO). */
  notReturnedByQbo: string[];
  note?: string;
  error?: string;
  completedAt?: string;
}

export interface ExportState {
  version: 1;
  realmId: string;
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  since: string | null;
  entities: Record<string, EntityProgress>;
}

export function newEntityProgress(): EntityProgress {
  return { status: 'pending', strategy: 0, part: 0, nextStartPosition: 1, fetched: 0, qboCount: null, notReturnedByQbo: [] };
}

/**
 * The resumable checkpoint (state/progress.json). Saves are serialized so
 * concurrent entity workers never interleave writes, and each save is atomic.
 */
export class StateStore {
  readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<ExportState | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as ExportState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  save(state: ExportState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    this.chain = this.chain.then(() => writeFileAtomic(this.path, snapshot));
    return this.chain;
  }

  /** Append-only list of IDs returned by QBO in the current run, per entity. */
  seenFile(entity: string): string {
    return join(dirname(this.path), 'seen', `${entity}.txt`);
  }

  async resetSeen(entity: string): Promise<void> {
    await rm(this.seenFile(entity), { force: true });
  }

  async appendSeen(entity: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await mkdir(dirname(this.seenFile(entity)), { recursive: true });
    await appendFile(this.seenFile(entity), ids.map((id) => `${id}\n`).join(''));
  }

  async readSeen(entity: string): Promise<Set<string>> {
    const text = await readFile(this.seenFile(entity), 'utf8').catch(() => '');
    return new Set(text.split('\n').filter(Boolean));
  }
}
