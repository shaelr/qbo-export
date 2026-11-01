// QBO sends money as bare JSON numbers (e.g. "TotalAmt": 1234.10). A plain
// JSON.parse turns those into floats and loses trailing zeros or precision.
// We use JSON source-text access (Node 21+) to keep every number as its
// original text, wrapped with JSON.rawJSON so it re-serializes byte-for-byte.

declare global {
  interface JSON {
    rawJSON(text: string): RawJSON;
    isRawJSON(value: unknown): value is RawJSON;
  }
}

export interface RawJSON {
  readonly rawJSON: string;
}

type ReviverWithSource = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown;

const keepNumberSource: ReviverWithSource = (_key, value, context) =>
  typeof value === 'number' && context.source !== undefined ? JSON.rawJSON(context.source) : value;

/** Parses JSON, keeping every number as a RawJSON holding its exact source text. */
export function parseLossless(text: string): unknown {
  return JSON.parse(text, keepNumberSource as Parameters<typeof JSON.parse>[1]);
}

/** Serializes a value from parseLossless with the original number text intact. */
export function stringifyLossless(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space);
}

/** The exact decimal text of a JSON number from parseLossless (or a plain number/string). */
export function numberText(value: unknown): string | undefined {
  if (JSON.isRawJSON(value)) return value.rawJSON;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return undefined;
}
