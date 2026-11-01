import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { assertReadOnly, type QboClient } from '../api/client.ts';
import type { ArchivePaths, AttachmentRecord, AttachmentSummary } from '../archive/layout.ts';
import { QboApiError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { writeFileAtomic } from '../util/atomic.ts';
import { numberText } from '../util/lossless-json.ts';
import { DEFAULT_RETRY, parseRetryAfter, RetryableError, withRetry, type RetryOptions } from '../util/retry.ts';
import { readRawRecords } from './csv.ts';

export interface AttachmentOptions {
  client: QboClient;
  log: Logger;
  /** Fetch used for the temporary file URLs (not the company API). */
  fetch?: typeof fetch;
  concurrency?: number;
  retry?: RetryOptions;
  /** Also download files not linked to any transaction (Receipts-inbox items). */
  includeUnlinked?: boolean;
  now?: () => Date;
  onProgress?: (done: number, total: number) => void;
}

export interface AttachmentResult {
  records: AttachmentRecord[];
  summary: AttachmentSummary;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Links from an Attachable's AttachableRef list; empty means unlinked (e.g. Receipts inbox). */
export function linksOf(attachable: Rec): AttachmentRecord['linkedTo'] {
  const refs = (attachable.AttachableRef as Rec[] | undefined) ?? [];
  return refs
    .map((r) => r.EntityRef as Rec | undefined)
    .filter((e): e is Rec => !!e && typeof e.value === 'string')
    .map((e) => ({ entityType: str(e.type) ?? 'Unknown', entityId: e.value as string }));
}

/**
 * Downloads the file behind every Attachable in raw/Attachable/ that is
 * linked to a transaction (unlinked ones too with includeUnlinked). Files that
 * are already present, unchanged in QBO, and still match their recorded
 * SHA-256 are skipped. Progress is checkpointed per file in
 * state/attachments.json, so an interrupted run resumes.
 */
export async function downloadAttachments(paths: ArchivePaths, options: AttachmentOptions): Promise<AttachmentResult> {
  const now = options.now ?? (() => new Date());
  const attachables = await readRawRecords(paths, 'Attachable');
  const previous = await loadAttachmentState(paths);
  const state: Record<string, AttachmentRecord> = { ...previous };
  let saveChain = Promise.resolve();
  const checkpoint = () => {
    const snapshot = JSON.stringify(state, null, 2);
    saveChain = saveChain.then(() => writeFileAtomic(paths.attachmentState, snapshot));
    return saveChain;
  };

  let downloaded = 0;
  let alreadyVerified = 0;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < attachables.length) {
      const att = attachables[next++]!;
      const outcome = await processAttachable(paths, options, att, previous[String(att.Id)], now);
      if (outcome.kind === 'downloaded') downloaded++;
      if (outcome.kind === 'verified') alreadyVerified++;
      state[outcome.record.attachableId] = outcome.record;
      await checkpoint();
      options.onProgress?.(++done, attachables.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, attachables.length)) }, worker));
  await saveChain;

  const records = Object.values(state).sort((a, b) => a.attachableId.localeCompare(b.attachableId, 'en', { numeric: true }));
  const withFile = records.filter((r) => r.status !== 'note-only');
  return {
    records,
    summary: {
      found: records.length,
      withFile: withFile.length,
      noteOnly: records.length - withFile.length,
      downloaded,
      alreadyVerified,
      failed: records.filter((r) => r.status === 'failed').length,
      sizeMismatches: records.filter((r) => r.sizeMatches === false).length,
      unlinked: withFile.filter((r) => r.linkedTo.length === 0).length,
      skippedUnlinked: records.filter((r) => r.status === 'skipped').length,
      totalBytes: records.reduce((sum, r) => sum + (r.status === 'downloaded' ? (r.sizeBytes ?? 0) : 0), 0),
    },
  };
}

type Outcome = { kind: 'downloaded' | 'verified' | 'failed' | 'note-only' | 'skipped'; record: AttachmentRecord };

async function processAttachable(
  paths: ArchivePaths,
  options: AttachmentOptions,
  att: Rec,
  prev: AttachmentRecord | undefined,
  now: () => Date,
): Promise<Outcome> {
  const id = String(att.Id);
  const fileName = str(att.FileName);
  const qboSizeText = numberText(att.Size);
  const base: AttachmentRecord = {
    attachableId: id,
    status: 'failed',
    fileName,
    path: null,
    category: str(att.Category),
    contentType: str(att.ContentType),
    qboSize: qboSizeText === undefined ? null : Number(qboSizeText),
    sizeBytes: null,
    sizeMatches: null,
    sha256: null,
    linkedTo: linksOf(att),
    attachableLastUpdated: str((att.MetaData as Rec | undefined)?.LastUpdatedTime),
    downloadedAt: null,
    verifiedAt: null,
  };
  if (!fileName) return { kind: 'note-only', record: { ...base, status: 'note-only' } };

  const finalPath = paths.attachmentFile(id, fileName);
  const relPath = relative(paths.root, finalPath);

  // By default only files attached to a transaction are downloaded. A copy
  // already in the archive from an earlier run is kept, never deleted.
  if (base.linkedTo.length === 0 && !options.includeUnlinked) {
    if (prev?.status === 'downloaded' && prev.sha256 && (await hashFile(finalPath).catch(() => undefined))?.sha256 === prev.sha256) {
      return { kind: 'verified', record: { ...prev, ...pick(base), verifiedAt: now().toISOString() } };
    }
    return { kind: 'skipped', record: { ...base, status: 'skipped', note: 'Not linked to any transaction; not downloaded (use --include-unlinked).' } };
  }

  // Already downloaded, unchanged in QBO, and the bytes on disk still match?
  if (prev?.status === 'downloaded' && prev.sha256 && prev.path === relPath && prev.attachableLastUpdated === base.attachableLastUpdated) {
    const existing = await hashFile(finalPath).catch(() => undefined);
    if (existing && existing.sha256 === prev.sha256 && existing.bytes === prev.sizeBytes) {
      return { kind: 'verified', record: { ...prev, ...pick(base), verifiedAt: now().toISOString() } };
    }
    options.log.warn({ attachableId: id }, existing ? 'Archived file changed on disk; re-downloading' : 'Archived file missing; re-downloading');
  }

  try {
    const result = await downloadOne(options, id, finalPath, base.qboSize);
    const at = now().toISOString();
    return {
      kind: 'downloaded',
      record: {
        ...base,
        status: 'downloaded',
        path: relPath,
        contentType: base.contentType ?? result.contentType,
        sizeBytes: result.bytes,
        sizeMatches: result.sizeMatches,
        sha256: result.sha256,
        downloadedAt: at,
        verifiedAt: at,
        ...(result.sizeMatches === false
          ? { error: `Size mismatch: QuickBooks says ${base.qboSize} bytes, received ${result.bytes} (file kept)` }
          : {}),
      },
    };
  } catch (err) {
    const error = describeDownloadError(err);
    options.log.warn({ attachableId: id, error }, 'Attachment download failed');
    // Keep an earlier good copy rather than discarding it because QBO now refuses.
    if (prev?.status === 'downloaded' && (await hashFile(finalPath).catch(() => undefined))?.sha256 === prev.sha256) {
      return { kind: 'verified', record: { ...prev, ...pick(base), verifiedAt: now().toISOString(), error: `Latest download failed: ${error}` } };
    }
    return { kind: 'failed', record: { ...base, error } };
  }
}

/** Metadata that should always reflect the latest Attachable record. */
function pick(base: AttachmentRecord) {
  return { linkedTo: base.linkedTo, category: base.category, qboSize: base.qboSize };
}

async function downloadOne(
  options: AttachmentOptions,
  id: string,
  finalPath: string,
  qboSize: number | null,
): Promise<{ bytes: number; sha256: string; sizeMatches: boolean | null; contentType: string | null }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const partPath = join(dir, `.download-${process.pid}.part`);

  const retry = { ...DEFAULT_RETRY, maxAttempts: 4, ...options.retry };
  return withRetry(
    async (attempt) => {
      // Temporary links expire within minutes, so ask for a new one right before each attempt.
      const url = await freshDownloadUrl(options.client, id);
      assertReadOnly('GET');
      let res: Response;
      try {
        // No Authorization header: this is a pre-signed URL on Intuit's file host.
        res = await fetchFn(url, { method: 'GET' });
      } catch (err) {
        throw new RetryableError('Network error downloading file', undefined, { cause: err });
      }
      if (res.status === 403 || res.status === 400 || res.status === 410) {
        await res.body?.cancel();
        throw new RetryableError(`Download link rejected (HTTP ${res.status}); requesting a new one`);
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        throw new RetryableError(`File host HTTP ${res.status}`, parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok || !res.body) throw new Error(`File download failed with HTTP ${res.status}`);

      const { bytes, sha256 } = await streamToFile(res.body as WebReadableStream<Uint8Array>, partPath).catch(async (err) => {
        await rm(partPath, { force: true });
        throw new RetryableError('Download interrupted', undefined, { cause: err });
      });
      const sizeMatches = qboSize === null ? null : bytes === qboSize;
      if (sizeMatches === false && attempt < retry.maxAttempts) {
        await rm(partPath, { force: true });
        throw new RetryableError(`Size mismatch: QuickBooks says ${qboSize} bytes, received ${bytes}`);
      }
      // On the last attempt a mismatched file is kept (and flagged) rather than lost.
      await rename(partPath, finalPath);
      return { bytes, sha256, sizeMatches, contentType: res.headers.get('content-type') };
    },
    retry,
  );
}

/** A fresh TempDownloadUri from the Attachable, falling back to the /download/<id> endpoint. */
export async function freshDownloadUrl(client: QboClient, id: string): Promise<string> {
  const { body } = await client.get(`attachable/${encodeURIComponent(id)}`);
  const uri = (body as { Attachable?: { TempDownloadUri?: unknown } }).Attachable?.TempDownloadUri;
  if (typeof uri === 'string' && uri.startsWith('https://')) return uri;
  const text = (await client.getText(`download/${encodeURIComponent(id)}`)).trim();
  if (!text.startsWith('https://')) throw new Error('QuickBooks did not return a download link for this attachment.');
  return text;
}

/** Streams to `path`, hashing as it goes, then fsyncs. */
async function streamToFile(body: WebReadableStream<Uint8Array>, path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body), meter, createWriteStream(path, { mode: 0o600 }));
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  await stat(path);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function loadAttachmentState(paths: ArchivePaths): Promise<Record<string, AttachmentRecord>> {
  try {
    return JSON.parse(await readFile(paths.attachmentState, 'utf8')) as Record<string, AttachmentRecord>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function describeDownloadError(err: unknown): string {
  if (err instanceof QboApiError && (err.status === 400 || err.status === 404)) {
    return `Attachable no longer available in QuickBooks (${err.message})`;
  }
  return err instanceof Error ? err.message : String(err);
}
