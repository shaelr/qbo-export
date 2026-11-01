import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runExport } from '../src/export/run.ts';
import { silentLogger } from '../src/log.ts';
import { fakeQbo, fault, json, makeClient, noSleep, tempDir } from './helpers.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

interface FileSpec {
  id: string;
  fileName?: string;
  content?: string;
  /** Size QBO reports; defaults to the real byte length. */
  size?: number;
  /** Defaults to a link to Purchase 107; pass [] for an unlinked (Receipts-inbox) file. */
  links?: Array<[string, string]>;
  updated?: string;
}

function attachableJson(f: FileSpec): string {
  const refs = (f.links ?? [['Purchase', '107']]).map(([type, value]) => `{"EntityRef":{"type":"${type}","value":"${value}"},"IncludeOnSend":false}`);
  const fileFields = f.fileName
    ? `"FileName":${JSON.stringify(f.fileName)},"Size":${f.size ?? Buffer.byteLength(f.content ?? '')},"ContentType":"application/pdf","Category":"Receipt",`
    : `"Note":"Call vendor about this",`;
  return `{"Id":"${f.id}",${fileFields}"AttachableRef":[${refs.join(',')}],"MetaData":{"LastUpdatedTime":"${f.updated ?? '2026-10-01T10:00:00-07:00'}"}}`;
}

/**
 * Company API (query + attachable/<id> + download/<id>) and a separate file
 * host serving pre-signed URLs. `fileResponses[id]` can queue overrides.
 */
function fakeIntuit(files: FileSpec[], extra: Record<string, string[]> = {}) {
  const log: string[] = [];
  const fileHeaders: Array<Record<string, string>> = [];
  let urlCounter = 0;
  const fileOverrides: Record<string, Array<() => Response>> = {};
  const attachableOverrides: Record<string, Response> = {};
  const noTempUri = new Set<string>();
  const query = fakeQbo({ Attachable: files.map(attachableJson), ...extra });

  const api = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const m = /\/(attachable|download)\/([^/]+)$/.exec(url.pathname);
    if (!m) return query.fetch(input, init);
    const [, kind, id] = m;
    log.push(`${kind}:${id}`);
    if (attachableOverrides[id!]) return attachableOverrides[id!]!;
    const signed = `https://files.intuit.example/${id}?sig=${++urlCounter}`;
    if (kind === 'download') return new Response(signed, { status: 200, headers: { 'content-type': 'text/plain' } });
    const att = JSON.parse(attachableJson(files.find((f) => f.id === id)!)) as Record<string, unknown>;
    return json(200, { Attachable: noTempUri.has(id!) ? att : { ...att, TempDownloadUri: signed }, time: 'x' });
  }) as typeof fetch;

  const host = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const id = url.pathname.slice(1);
    log.push(`file:${id}`);
    fileHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const override = fileOverrides[id]?.shift();
    if (override) return override();
    const f = files.find((x) => x.id === id)!;
    return new Response(f.content ?? '', { status: 200, headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;

  return { api, host, log, fileHeaders, fileOverrides, attachableOverrides, noTempUri };
}

async function exportWith(dir: string, intuit: ReturnType<typeof fakeIntuit>, only = ['Invoice', 'Attachable'], includeUnlinked = false) {
  const client = await makeClient(intuit.api);
  return runExport({
    client,
    log: silentLogger,
    outDir: dir,
    only,
    environment: 'sandbox',
    minorVersion: '75',
    fileFetch: intuit.host,
    fileRetry: { maxAttempts: 4, ...noSleep },
    includeUnlinked,
  });
}

const INVOICE_130 = '{"Id":"130","DocNumber":"1037","TxnDate":"2024-05-01","TotalAmt":113.00}';

describe('attachment download', () => {
  it('downloads linked files with checksums, original names and link metadata, and skips unlinked ones', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit(
      [
        { id: '500', fileName: 'Staples receipt.pdf', content: '%PDF-1 staples', links: [['Invoice', '130'], ['Purchase', '107']] },
        { id: '501', fileName: 'IMG_2041.jpg', content: 'jpeg-bytes-inbox', links: [] }, // Receipts inbox: no AttachableRef
        { id: '502' }, // note only
      ],
      { Invoice: [INVOICE_130] },
    );
    const { attachments, manifest } = await exportWith(dir, intuit);

    expect(await readFile(join(dir, 'attachments', '500', 'Staples receipt.pdf'), 'utf8')).toBe('%PDF-1 staples');
    await expect(readdir(join(dir, 'attachments', '501'))).rejects.toThrow(); // never downloaded
    expect(intuit.log).not.toContain('attachable:501');
    const byId = Object.fromEntries(attachments!.records.map((r) => [r.attachableId, r]));
    expect(byId['500']).toMatchObject({
      status: 'downloaded',
      sha256: sha('%PDF-1 staples'),
      sizeBytes: 14,
      qboSize: 14,
      sizeMatches: true,
      contentType: 'application/pdf',
      path: join('attachments', '500', 'Staples receipt.pdf'),
      linkedTo: [
        { entityType: 'Invoice', entityId: '130' },
        { entityType: 'Purchase', entityId: '107' },
      ],
    });
    expect(byId['501']).toMatchObject({ status: 'skipped', linkedTo: [], sha256: null });
    expect(byId['501']!.note).toMatch(/--include-unlinked/);
    expect(byId['502']!.status).toBe('note-only');
    expect(attachments!.summary).toMatchObject({ found: 3, withFile: 2, noteOnly: 1, downloaded: 1, failed: 0, unlinked: 1, skippedUnlinked: 1, totalBytes: 14 });

    expect(manifest.attachmentSummary).toEqual(attachments!.summary);
    expect(manifest.attachments.find((a) => a.attachableId === '500')!.sha256).toBe(sha('%PDF-1 staples'));
    expect(manifest.entities.Attachable).toMatchObject({ fetched: 3, qboCount: 3 });

    const csv = await readFile(join(dir, 'csv', 'attachments.csv'), 'utf8');
    expect(csv).toContain('Invoice 1037 (#130); Purchase (#107)');
    expect(csv).toMatch(/501,IMG_2041\.jpg,Receipt,skipped,,yes/);
  });

  it('downloads unlinked files too with includeUnlinked', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit([{ id: '501', fileName: 'IMG_2041.jpg', content: 'jpeg-bytes-inbox', links: [] }]);
    const { attachments } = await exportWith(dir, intuit, ['Attachable'], true);
    expect(attachments!.records[0]).toMatchObject({ status: 'downloaded', sha256: sha('jpeg-bytes-inbox'), linkedTo: [] });
    expect(attachments!.summary).toMatchObject({ unlinked: 1, skippedUnlinked: 0, downloaded: 1 });
  });

  it('keeps an unlinked file downloaded by an earlier run instead of discarding it', async () => {
    const dir = await tempDir();
    const files: FileSpec[] = [{ id: '502', fileName: 'old-inbox.jpg', content: 'kept', links: [] }];
    await exportWith(dir, fakeIntuit(files), ['Attachable'], true);
    const later = fakeIntuit(files);
    const { attachments } = await exportWith(dir, later, ['Attachable']);
    expect(attachments!.records[0]).toMatchObject({ status: 'downloaded', sha256: sha('kept') });
    expect(attachments!.summary.alreadyVerified).toBe(1);
    expect(later.log.some((l) => l.startsWith('file:'))).toBe(false);
  });

  it('requests a fresh link right before each download and never sends the QBO token to the file host', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit([
      { id: '1', fileName: 'a.pdf', content: 'aaa' },
      { id: '2', fileName: 'b.pdf', content: 'bbb' },
    ]);
    await exportWith(dir, intuit, ['Attachable']);
    for (const id of ['1', '2']) {
      const linkAt = intuit.log.indexOf(`attachable:${id}`);
      expect(linkAt).toBeGreaterThanOrEqual(0);
      expect(intuit.log[linkAt + 1] === `file:${id}` || intuit.log.indexOf(`file:${id}`) > linkAt).toBe(true);
    }
    for (const h of intuit.fileHeaders) expect(h.authorization).toBeUndefined();
  });

  it('gets a new link when the temporary one has expired', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit([{ id: '7', fileName: 'r.pdf', content: 'receipt' }]);
    intuit.fileOverrides['7'] = [() => new Response('<Error>Request has expired</Error>', { status: 403 })];
    const { attachments } = await exportWith(dir, intuit, ['Attachable']);
    expect(attachments!.records[0]).toMatchObject({ status: 'downloaded', sha256: sha('receipt') });
    expect(intuit.log.filter((l) => l === 'attachable:7')).toHaveLength(2);
  });

  it('falls back to the /download endpoint when no TempDownloadUri is given', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit([{ id: '8', fileName: 'x.png', content: 'png' }]);
    intuit.noTempUri.add('8');
    const { attachments } = await exportWith(dir, intuit, ['Attachable']);
    expect(attachments!.records[0]!.status).toBe('downloaded');
    expect(intuit.log).toContain('download:8');
  });

  it('retries a truncated download, and keeps but flags a file whose size never matches', async () => {
    const dir = await tempDir();
    const intuit = fakeIntuit([
      { id: '10', fileName: 'ok.pdf', content: 'complete-file' },
      { id: '11', fileName: 'odd.jpg', content: 'twelve bytes', size: 99 },
    ]);
    intuit.fileOverrides['10'] = [() => new Response('compl', { status: 200 })];
    const { attachments } = await exportWith(dir, intuit, ['Attachable']);
    const byId = Object.fromEntries(attachments!.records.map((r) => [r.attachableId, r]));
    expect(byId['10']).toMatchObject({ status: 'downloaded', sizeMatches: true, sizeBytes: 13 });
    expect(byId['11']).toMatchObject({ status: 'downloaded', sizeMatches: false, sizeBytes: 12, qboSize: 99 });
    expect(byId['11']!.error).toMatch(/Size mismatch.*file kept/);
    expect(attachments!.summary.sizeMismatches).toBe(1);
    expect(await readdir(join(dir, 'attachments', '10'))).toEqual(['ok.pdf']); // no .part left behind
  });

  it('skips verified files on re-run, and re-downloads ones that are corrupted or changed in QBO', async () => {
    const dir = await tempDir();
    const files: FileSpec[] = [
      { id: '20', fileName: 'keep.pdf', content: 'keep' },
      { id: '21', fileName: 'corrupt.pdf', content: 'original' },
      { id: '22', fileName: 'changed.pdf', content: 'v1' },
    ];
    await exportWith(dir, fakeIntuit(files), ['Attachable']);
    await writeFile(join(dir, 'attachments', '21', 'corrupt.pdf'), 'bit rot!');

    files[2] = { id: '22', fileName: 'changed.pdf', content: 'v2-new', updated: '2026-10-30T09:00:00-07:00' };
    const second = fakeIntuit(files);
    const { attachments } = await exportWith(dir, second, ['Attachable']);
    expect(second.log.filter((l) => l.startsWith('file:')).sort()).toEqual(['file:21', 'file:22']);
    expect(attachments!.summary).toMatchObject({ downloaded: 2, alreadyVerified: 1, failed: 0 });
    expect(await readFile(join(dir, 'attachments', '21', 'corrupt.pdf'), 'utf8')).toBe('original');
    expect(await readFile(join(dir, 'attachments', '22', 'changed.pdf'), 'utf8')).toBe('v2-new');
  });

  it('keeps an archived copy if QBO later refuses, and reports never-downloaded failures with a reason', async () => {
    const dir = await tempDir();
    const files: FileSpec[] = [{ id: '30', fileName: 'had.pdf', content: 'had-it' }];
    await exportWith(dir, fakeIntuit(files), ['Attachable']);

    files[0] = { ...files[0]!, updated: '2026-10-30T00:00:00-07:00' }; // changed, so a re-download is attempted
    files.push({ id: '31', fileName: 'gone.pdf', content: 'x' });
    const later = fakeIntuit(files);
    later.attachableOverrides['30'] = fault(400, '610', 'Object Not Found', 'Something you are trying to use has been made inactive or deleted');
    later.attachableOverrides['31'] = fault(400, '610', 'Object Not Found', 'deleted');
    const { attachments } = await exportWith(dir, later, ['Attachable']);
    const byId = Object.fromEntries(attachments!.records.map((r) => [r.attachableId, r]));
    expect(byId['30']).toMatchObject({ status: 'downloaded', sha256: sha('had-it') }); // earlier good copy kept
    expect(byId['30']!.error).toMatch(/Latest download failed/);
    expect(await readFile(join(dir, 'attachments', '30', 'had.pdf'), 'utf8')).toBe('had-it');
    expect(byId['31']).toMatchObject({ status: 'failed' });
    expect(byId['31']!.error).toMatch(/no longer available in QuickBooks/);
  });

  it('keeps hostile file names inside the attachment folder', async () => {
    const dir = await tempDir();
    const { attachments } = await exportWith(dir, fakeIntuit([{ id: '40', fileName: '../../evil.sh', content: 'echo' }]), ['Attachable']);
    expect(attachments!.records[0]!.path).toBe(join('attachments', '40', '.._.._evil.sh'));
    expect(await readdir(join(dir, 'attachments', '40'))).toEqual(['.._.._evil.sh']);
  });
});
