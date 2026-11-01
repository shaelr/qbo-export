import type { QboClient } from '../api/client.ts';
import type { ArchivePaths, Manifest } from '../archive/layout.ts';
import type { Logger } from '../log.ts';
import { buildVerification, writeVerification, type VerificationReport } from '../report/verify.ts';
import type { QboEnvironment } from '../config.ts';
import type { RetryOptions } from '../util/retry.ts';
import { downloadAttachments, type AttachmentResult } from './attachments.ts';
import { writeAttachmentsCsv, writeCsvs } from './csv.ts';
import { ENTITIES } from './entities.ts';
import { exportRecords, withArchiveLock, type ExportOptions, type ExportRun } from './exporter.ts';
import { writeManifest } from './manifest.ts';

export interface RunExportOptions extends ExportOptions {
  outDir: string;
  environment: QboEnvironment;
  minorVersion: string;
  skipAttachments?: boolean;
  includeUnlinked?: boolean;
  /** Fetch for temporary attachment URLs (tests); defaults to global fetch. */
  fileFetch?: typeof fetch;
  fileRetry?: RetryOptions;
  onAttachmentProgress?: (done: number, total: number) => void;
}

export interface RunExportResult {
  run: ExportRun;
  manifest: Manifest;
  csvFiles: string[];
  attachments: AttachmentResult | undefined;
  verification: { report: VerificationReport; markdown: string } | { error: string };
}

/**
 * One export pass, all under the archive lock: records, then attachment
 * files (when Attachable metadata was part of this run), then CSVs and the manifest.
 */
export function runExport(options: RunExportOptions): Promise<RunExportResult> {
  return withArchiveLock(options.outDir, async (paths) => {
    const run = await exportRecords(paths, options);
    const wantAttachments = !options.skipAttachments && run.specs.some((s) => s.name === 'Attachable');
    const attachments = wantAttachments
      ? await downloadAttachments(paths, {
          client: options.client,
          log: options.log,
          fetch: options.fileFetch,
          retry: options.fileRetry,
          includeUnlinked: options.includeUnlinked,
          now: options.now,
          onProgress: options.onAttachmentProgress,
        })
      : undefined;
    const csvFiles = await writeCsvs(paths);
    if (attachments) csvFiles.push(await writeAttachmentsCsv(paths, attachments.records));
    const manifest = await writeManifest(
      paths,
      run.state,
      run.specs,
      { environment: options.environment, minorVersion: options.minorVersion, finishedAt: (options.now ?? (() => new Date()))() },
      attachments,
    );
    const verification = await verifyArchive(paths, { client: options.client, log: options.log, manifest, now: options.now });
    return { run, manifest, csvFiles, attachments, verification };
  });
}

/** Builds and writes report/verification.{md,json}. A failure here never undoes the export. */
export async function verifyArchive(
  paths: ArchivePaths,
  options: { client: QboClient; log: Logger; manifest: Manifest; now?: () => Date },
): Promise<RunExportResult['verification']> {
  try {
    const report = await buildVerification(paths, { ...options, allEntities: ENTITIES.map((e) => e.name) });
    const { markdown } = await writeVerification(paths, report);
    return { report, markdown };
  } catch (err) {
    options.log.error({ error: (err as Error).message }, 'Verification report failed');
    return { error: (err as Error).message };
  }
}
