#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { QboClient } from './api/client.ts';
import { authorize, type AuthorizeMode } from './auth/authorize-flow.ts';
import { OAuthClient, toStoredTokens } from './auth/oauth.ts';
import { terminalPassphrase } from './auth/passphrase.ts';
import { TokenManager } from './auth/token-manager.ts';
import { TokenStore } from './auth/token-store.ts';
import { loadConfig, TOOL_VERSION, type Config } from './config.ts';
import { UserFacingError } from './errors.ts';
import { validateSince } from './export/entities.ts';
import { withArchiveLock } from './export/exporter.ts';
import { readManifest } from './export/manifest.ts';
import { runExport, verifyArchive } from './export/run.ts';
import { createLogger, type Logger } from './log.ts';
import { numberText, stringifyLossless } from './util/lossless-json.ts';

const print = (line: string) => process.stdout.write(`${line}\n`);

function setup(): { config: Config; log: Logger; store: TokenStore; oauth: OAuthClient } {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel });
  const store = new TokenStore(config.tokenFile, terminalPassphrase);
  const oauth = new OAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    log,
  });
  return { config, log, store, oauth };
}

const program = new Command()
  .name('qbo-export')
  .description('Read-only export of a QuickBooks Online company to a local archive.')
  .version(TOOL_VERSION);

program
  .command('auth')
  .description('Connect a QuickBooks company (one-time OAuth consent) and store tokens encrypted.')
  .option('--paste', 'paste the redirect URL instead of running a local listener')
  .option('--local', 'force the local http://localhost listener')
  .option('--no-browser', 'do not try to open a browser')
  .option('--reset', 'discard any existing stored tokens first (e.g. forgotten passphrase)')
  .action(async (opts: { paste?: boolean; local?: boolean; browser: boolean; reset?: boolean }) => {
    const { config, log, store, oauth } = setup();
    print(`Environment: ${config.environment}  (redirect URI: ${config.redirectUri})`);
    if (opts.reset) {
      await store.clear();
      print('Existing tokens removed.');
    }
    const mode: AuthorizeMode = opts.paste ? 'paste' : opts.local ? 'local' : 'auto';
    const { code, realmId } = await authorize({ oauth, redirectUri: config.redirectUri, mode, openBrowser: opts.browser, print });
    const tokens = toStoredTokens(await oauth.exchangeCode(code), realmId, config.environment, Date.now());
    await store.save(tokens);
    log.info({ realmId }, 'Authorization stored');
    print(`Connected company ${realmId}. Tokens saved (encrypted) to ${config.tokenFile}`);
    print('Next: `npm run qbo -- whoami` to check the connection.');
  });

program
  .command('whoami')
  .description('Show the connected company (reads CompanyInfo; makes no changes).')
  .action(async () => {
    const { config, log, store, oauth } = setup();
    const tokens = new TokenManager({ store, oauth, log });
    const realmId = await tokens.realmId();
    const client = new QboClient({ baseUrl: config.apiBaseUrl, realmId, minorVersion: config.minorVersion, tokens, log });
    const { body } = await client.get(`companyinfo/${encodeURIComponent(realmId)}`);
    const info = (body as { CompanyInfo?: Record<string, unknown> }).CompanyInfo ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : (numberText(v) ?? '-'));
    print(`Company:            ${str(info.CompanyName)}`);
    print(`Legal name:         ${str(info.LegalName)}`);
    print(`Country:            ${str(info.Country)}`);
    print(`Fiscal year starts: ${str(info.FiscalYearStartMonth)}`);
    print(`Realm ID:           ${realmId}`);
    print(`Environment:        ${config.environment}`);
    if (info.Country && info.Country !== 'CA') {
      print(`Note: this company's country is ${str(info.Country)}, not CA.`);
    }
  });

program
  .command('query <sql>')
  .description('Run one read-only QBO query and print the JSON (for diagnosis), e.g. "select count(*) from Attachable".')
  .action(async (sql: string) => {
    if (!/^\s*select\s/i.test(sql)) throw new UserFacingError('Only SELECT queries are allowed.');
    const { config, log, store, oauth } = setup();
    const tokens = new TokenManager({ store, oauth, log });
    const realmId = await tokens.realmId();
    const client = new QboClient({ baseUrl: config.apiBaseUrl, realmId, minorVersion: config.minorVersion, tokens, log });
    const { body } = await client.get('query', { query: sql });
    print(stringifyLossless(body, 2));
  });

program
  .command('verify')
  .description('Re-check an existing archive against QuickBooks and rewrite report/verification.md (read-only).')
  .requiredOption('--out <dir>', 'archive folder')
  .action(async (opts: { out: string }) => {
    const { config, log, store, oauth } = setup();
    const tokens = new TokenManager({ store, oauth, log });
    const realmId = await tokens.realmId();
    const client = new QboClient({ baseUrl: config.apiBaseUrl, realmId, minorVersion: config.minorVersion, tokens, log });
    const result = await withArchiveLock(resolve(opts.out), async (paths) => {
      const manifest = await readManifest(paths);
      if (!manifest) throw new UserFacingError(`No manifest.json in ${opts.out}. Run an export first.`);
      if (manifest.realmId !== realmId) throw new UserFacingError(`This archive belongs to company ${manifest.realmId}, but you are connected to ${realmId}.`);
      return verifyArchive(paths, { client, log, manifest });
    });
    printVerification(result);
  });

program
  .command('export')
  .description('Export all records to an archive folder (read-only; resumable; safe to re-run).')
  .requiredOption('--out <dir>', 'archive folder (put it on an encrypted volume)')
  .option('--since <date>', 'only records changed on/after this date (YYYY-MM-DD or ISO timestamp)')
  .option('--fresh', 'ignore an unfinished previous run and start over')
  .option('--only <entities>', 'comma-separated entity names, e.g. Invoice,Customer')
  .option('--skip-attachments', 'export Attachable metadata but do not download files')
  .option('--include-unlinked', 'also download files not linked to any transaction (Receipts inbox)')
  .action(async (opts: { out: string; since?: string; fresh?: boolean; only?: string; skipAttachments?: boolean; includeUnlinked?: boolean }) => {
    const config = loadConfig();
    const outDir = resolve(opts.out);
    const startedAt = new Date();
    const log = createLogger({
      level: config.logLevel,
      file: join(outDir, 'logs', `export-${startedAt.toISOString().replace(/[:.]/g, '-')}.jsonl`),
    });
    const store = new TokenStore(config.tokenFile, terminalPassphrase);
    const oauth = new OAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, log });
    const tokens = new TokenManager({ store, oauth, log });
    const realmId = await tokens.realmId();
    const client = new QboClient({ baseUrl: config.apiBaseUrl, realmId, minorVersion: config.minorVersion, tokens, log });
    const since = opts.since ? validateSince(opts.since) : null;

    print(`Exporting ${config.environment} company ${realmId} to ${outDir}${since ? ` (changed since ${since})` : ''}`);
    let lastShown = 0;
    const { run, manifest, csvFiles: csvs, attachments, verification } = await runExport({
      client,
      outDir,
      log,
      since,
      fresh: opts.fresh,
      only: opts.only?.split(',').map((s) => s.trim()).filter(Boolean),
      environment: config.environment,
      minorVersion: config.minorVersion,
      skipAttachments: opts.skipAttachments,
      includeUnlinked: opts.includeUnlinked,
      onAttachmentProgress: (done, total) => {
        if (done === total || done - lastShown >= 25) {
          lastShown = done;
          print(`  Attachments: ${done}/${total} checked`);
        }
      },
      onProgress: (entity, p) => print(`  ${entity.padEnd(18)} ${p.status.padEnd(9)} ${String(p.fetched).padStart(6)} records`),
    });
    if (run.resumed) print('(Resumed an unfinished run.)');

    print('');
    print(`${'Entity'.padEnd(18)} ${'Status'.padEnd(10)} ${'Fetched'.padStart(8)} ${'QBO count'.padStart(10)} ${'In archive'.padStart(11)}`);
    for (const spec of run.specs) {
      const e = manifest.entities[spec.name]!;
      const mismatch = e.status === 'complete' && e.qboCount !== null && e.qboCount !== e.fetched ? '  <- differs' : '';
      print(
        `${spec.name.padEnd(18)} ${e.status.padEnd(10)} ${String(e.fetched).padStart(8)} ${String(e.qboCount ?? '-').padStart(10)} ${String(e.filesInArchive).padStart(11)}${mismatch}`,
      );
      if (e.notReturnedByQbo.length > 0) print(`  ${e.notReturnedByQbo.length} archived record(s) no longer returned by QBO (kept): ${e.notReturnedByQbo.join(', ')}`);
      if (e.error) print(`  error: ${e.error}`);
    }
    if (attachments) {
      const a = attachments.summary;
      print('');
      print(
        `Attachments: ${a.found} found (${a.withFile} files, ${a.noteOnly} notes), ${a.downloaded} downloaded, ` +
          `${a.alreadyVerified} already archived and verified, ${a.failed} failed, ${formatBytes(a.totalBytes)} total`,
      );
      print(
        `  ${a.unlinked} unlinked (not attached to any transaction)` +
          (a.skippedUnlinked > 0 ? `: ${a.skippedUnlinked} not downloaded; use --include-unlinked to download them` : ''),
      );
      for (const r of attachments.records.filter((r) => r.error)) print(`  attachment ${r.attachableId} (${r.fileName ?? 'no file'}): ${r.error}`);
    }
    print('');
    print(`CSV files: ${csvs.map((c) => join('csv', c)).join(', ')}`);
    print(`Manifest:  ${run.paths.manifest}`);
    printVerification(verification);
    const attachmentFailures = attachments?.summary.failed ?? 0;
    if (attachmentFailures > 0) {
      print(`${attachmentFailures} attachment(s) failed to download. Re-run the same command to retry them.`);
      process.exitCode = 1;
    }
    const failed = run.specs.filter((s) => manifest.entities[s.name]!.status !== 'complete' && manifest.entities[s.name]!.status !== 'skipped');
    if (failed.length > 0) {
      print(`${failed.length} entit${failed.length === 1 ? 'y' : 'ies'} did not finish. Re-run the same command to resume.`);
      process.exitCode = 1;
    }
  });

function printVerification(v: Awaited<ReturnType<typeof verifyArchive>>): void {
  print('');
  if ('error' in v) {
    print(`Verification report could not be generated: ${v.error}`);
    process.exitCode = 1;
    return;
  }
  if (v.report.overall === 'pass') print('Verification: ✅ all checks passed.');
  else {
    print(`Verification: ⚠️ ${v.report.attention.length} item(s) need attention:`);
    for (const a of v.report.attention) print(`  - ${a}`);
  }
  print(`Report:    ${v.markdown}`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof UserFacingError) {
    process.stderr.write(`Error: ${err.message}\n`);
  } else {
    // Unexpected: show the message and class, never request/response objects.
    process.stderr.write(`Unexpected error (${(err as Error)?.name ?? 'Error'}): ${(err as Error)?.message ?? String(err)}\n`);
  }
  process.exitCode = 1;
});
