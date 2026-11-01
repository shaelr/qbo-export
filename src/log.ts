import pino, { type Logger } from 'pino';

export type { Logger };

// Belt and braces: callers should never pass secrets or customer data to the
// logger, but if a token-shaped field slips into a log object it is censored.
const REDACT_PATHS = [
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'authorization',
  'Authorization',
  'client_secret',
  'clientSecret',
  'passphrase',
  'code',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.Authorization',
  '*.client_secret',
  '*.clientSecret',
  '*.passphrase',
  '*.code',
  'headers.authorization',
];

export interface LoggerOptions {
  level?: string;
  /** Optional JSONL file that receives debug-level logs (e.g. the archive's logs/ dir). */
  file?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const consoleLevel = options.level ?? 'warn';
  const streams: pino.StreamEntry[] = [{ level: consoleLevel as pino.Level, stream: pino.destination(2) }];
  if (options.file) {
    streams.push({ level: 'debug', stream: pino.destination({ dest: options.file, mkdir: true, sync: false }) });
  }
  return pino(
    {
      level: options.file ? 'debug' : consoleLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}

export const silentLogger: Logger = pino({ level: 'silent' });
