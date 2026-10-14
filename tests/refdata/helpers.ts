import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

const SAMPLE = path.resolve(__dirname, '../fixtures/refdata/wiktionary-sample.jsonl');

/** Real rows from the Wiktionary dump (scripts/refdata/sample-wiktionary.ts). */
export function sampleRows(): any[] {
  return fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

export function sampleRow(word: string, pos: string, etymologyNumber?: string): any {
  const row = sampleRows().find((r) => r.word === word && r.pos === pos && (etymologyNumber === undefined || r.etymology_number === etymologyNumber));
  if (!row) throw new Error(`fixture row not found: ${word}/${pos}`);
  return row;
}

/** Serializes like the dump (Python json.dumps): a space after ':' and after ',' — `"lang_code": "en"`. */
export function dumpLine(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(dumpLine).join(', ') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>).map(([k, v]) => JSON.stringify(k) + ': ' + dumpLine(v)).join(', ') + '}';
  }
  return JSON.stringify(value);
}

/** A minimal English row in dump format. */
export const enRow = (word: string, extra: Record<string, unknown> = {}) => ({
  word,
  pos: 'noun',
  lang: 'English',
  lang_code: 'en',
  senses: [{ glosses: [`a ${word}`] }],
  ...extra,
});

/** Writes a small .gz in the temp dir (never anywhere else). Returns the path; call `cleanup()` after. */
export function makeGz(lines: string[], opts: { truncate?: boolean } = {}): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refdata-test-'));
  const file = path.join(dir, 'dump.jsonl.gz');
  let buf = zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  if (opts.truncate) buf = buf.subarray(0, Math.floor(buf.length * 0.6));
  fs.writeFileSync(file, buf);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
