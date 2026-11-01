/** Errors whose message is safe and useful to show the user verbatim. */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}

export class ConfigError extends UserFacingError {
  override name = 'ConfigError';
}

export class NotAuthorizedError extends UserFacingError {
  override name = 'NotAuthorizedError';
  constructor(message = 'Not authorized yet. Run `npm run qbo -- auth` to connect a QuickBooks company.') {
    super(message);
  }
}

/** The refresh token is expired, revoked, or otherwise rejected by Intuit. */
export class ReauthorizeRequiredError extends UserFacingError {
  override name = 'ReauthorizeRequiredError';
  constructor(reason: string) {
    super(
      `QuickBooks authorization is no longer valid (${reason}). ` +
        'Run `npm run qbo -- auth` to reconnect. Nothing in QuickBooks was changed.',
    );
  }
}

export class WrongPassphraseError extends UserFacingError {
  override name = 'WrongPassphraseError';
  constructor() {
    super('Could not decrypt the token store: wrong passphrase, or the file was modified.');
  }
}

/** A refreshed token pair could not be written to disk. */
export class TokenPersistError extends UserFacingError {
  override name = 'TokenPersistError';
}

export class ReadOnlyViolationError extends Error {
  override name = 'ReadOnlyViolationError';
}

export interface QboFaultDetail {
  code?: string;
  message?: string;
  detail?: string;
}

export class QboApiError extends Error {
  override name = 'QboApiError';
  readonly status: number;
  readonly intuitTid: string | undefined;
  readonly faults: QboFaultDetail[];

  constructor(status: number, intuitTid: string | undefined, faults: QboFaultDetail[]) {
    const summary = faults.map((f) => [f.code, f.message, f.detail].filter(Boolean).join(': ')).join('; ');
    super(`QuickBooks API error ${status}${summary ? `: ${summary}` : ''}${intuitTid ? ` (intuit_tid ${intuitTid})` : ''}`);
    this.status = status;
    this.intuitTid = intuitTid;
    this.faults = faults;
  }
}
