import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCHIVE_SCHEMA_VERSION, type ArchivePaths, type EntityManifestEntry, type Manifest } from '../archive/layout.ts';
import { TOOL_VERSION, type QboEnvironment } from '../config.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import type { AttachmentResult } from './attachments.ts';
import type { EntitySpec } from './entities.ts';
import type { ExportState } from './state.ts';

export async function readManifest(paths: ArchivePaths): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(paths.manifest, 'utf8')) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function countFiles(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).length;
}

/**
 * Writes manifest.json from the run state. Entities not part of this run
 * (e.g. with --only) are kept, as are attachment entries when this run did
 * not process attachments.
 */
export async function writeManifest(
  paths: ArchivePaths,
  state: ExportState,
  specs: EntitySpec[],
  meta: { environment: QboEnvironment; minorVersion: string; finishedAt: Date },
  attachments?: AttachmentResult,
): Promise<Manifest> {
  const previous = await readManifest(paths);
  const entities: Record<string, EntityManifestEntry> = { ...previous?.entities };
  for (const spec of specs) {
    const p = state.entities[spec.name];
    if (!p) continue;
    entities[spec.name] = {
      fetched: p.fetched,
      qboCount: p.qboCount,
      filesInArchive: await countFiles(join(paths.raw, spec.name)),
      notReturnedByQbo: p.notReturnedByQbo,
      status: p.status === 'complete' || p.status === 'skipped' || p.status === 'failed' ? p.status : 'incomplete',
      ...(p.note ? { note: p.note } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  }

  const manifest: Manifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    environment: meta.environment,
    realmId: state.realmId,
    companyName: await companyName(paths),
    minorVersion: meta.minorVersion,
    firstExportStartedAt: previous?.firstExportStartedAt ?? previous?.exportStartedAt ?? state.startedAt,
    exportStartedAt: state.startedAt,
    exportFinishedAt: meta.finishedAt.toISOString(),
    since: state.since,
    entities,
    attachmentSummary: attachments?.summary ?? previous?.attachmentSummary ?? null,
    attachments: attachments?.records ?? previous?.attachments ?? [],
  };
  await writeFileAtomic(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function companyName(paths: ArchivePaths): Promise<string | null> {
  const dir = join(paths.raw, 'CompanyInfo');
  const file = (await readdir(dir).catch(() => [] as string[])).find((f) => f.endsWith('.json'));
  if (!file) return null;
  const info = JSON.parse(await readFile(join(dir, file), 'utf8')) as { CompanyName?: string };
  return info.CompanyName ?? null;
}
