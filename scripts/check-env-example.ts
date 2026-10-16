/**
 * Keeps .env.example and the configuration schema (config/lookup.ts, docs/lookup-spec.md §1) in step. Part of `npm test`
 * (the project has no linter); also `npm run check:env-example`.
 *
 * Fails (exit 1) when:
 *   - a variable of the schema is missing from .env.example,
 *   - the lookup section of .env.example holds a variable that the schema does not know (a typo, or one that was removed),
 *   - a variable appears twice,
 *   - a schema variable is written ABOVE the lookup section (it would not be checked there),
 *   - the example values do not load: loadLookupConfig() rejects them (wrong type, out of range, a key missing for a feature that is on).
 *
 * The lookup section is everything after the line that names "docs/lookup-spec.md §1". Variables above it (PORT, DB_*, SESSION_SECRET…)
 * belong to the rest of the application and are not compared. Only names are printed, never values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadLookupConfig, lookupEnvSchema, LookupConfigError } from '../config/lookup';

export interface EnvExampleReport {
  ok: boolean;
  /** schema variables absent from the example */
  missing: string[];
  /** variables in the lookup section that the schema does not define */
  extra: string[];
  duplicates: string[];
  /** schema variables written above the lookup section */
  misplaced: string[];
  /** problems from loadLookupConfig (names and messages, no values) */
  invalid: string[];
  /** the marker line was not found */
  markerMissing: boolean;
}

export const LOOKUP_SECTION_MARKER = /docs\/lookup-spec\.md\s*§\s*1/;
const ASSIGNMENT = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/;

export interface ParsedExample {
  /** [name, value, inLookupSection] in file order */
  entries: Array<{ name: string; value: string; lookup: boolean }>;
  markerMissing: boolean;
}

export function parseEnvExample(text: string): ParsedExample {
  const entries: ParsedExample['entries'] = [];
  let lookup = false;
  let markerSeen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      if (!markerSeen && LOOKUP_SECTION_MARKER.test(line)) {
        markerSeen = true;
        lookup = true;
      }
      continue;
    }
    const m = ASSIGNMENT.exec(raw);
    if (m) entries.push({ name: m[1], value: m[2].trim(), lookup });
  }
  return { entries, markerMissing: !markerSeen };
}

export function checkEnvExample(text: string, schemaKeys: readonly string[], load: (env: Record<string, string>) => unknown = loadLookupConfig as any): EnvExampleReport {
  const parsed = parseEnvExample(text);
  const schema = new Set(schemaKeys);
  const inSection = parsed.entries.filter((e) => e.lookup);
  const seen = new Map<string, number>();
  for (const e of parsed.entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);

  const present = new Set(inSection.map((e) => e.name));
  const missing = [...schema].filter((k) => !present.has(k)).sort();
  const extra = [...new Set(inSection.map((e) => e.name).filter((k) => !schema.has(k)))].sort();
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
  const misplaced = [...new Set(parsed.entries.filter((e) => !e.lookup && schema.has(e.name)).map((e) => e.name))].sort();

  // Do the example values load? (Only the schema variables; the rest of the file is not ours.)
  const env: Record<string, string> = {};
  for (const e of inSection) if (schema.has(e.name)) env[e.name] = e.value;
  const invalid: string[] = [];
  try {
    load(env);
  } catch (err) {
    if (err instanceof LookupConfigError) invalid.push(...err.issues);
    else invalid.push(String((err as Error)?.message ?? err));
  }

  const ok = !parsed.markerMissing && missing.length === 0 && extra.length === 0 && duplicates.length === 0 && misplaced.length === 0 && invalid.length === 0;
  return { ok, missing, extra, duplicates, misplaced, invalid, markerMissing: parsed.markerMissing };
}

export function describeReport(r: EnvExampleReport): string[] {
  const lines: string[] = [];
  if (r.markerMissing) lines.push('  - không thấy dòng chú thích "docs/lookup-spec.md §1" mở đầu phần tra từ của .env.example');
  for (const k of r.missing) lines.push(`  - THIẾU trong .env.example: ${k}`);
  for (const k of r.extra) lines.push(`  - THỪA (schema không có): ${k}`);
  for (const k of r.duplicates) lines.push(`  - TRÙNG: ${k}`);
  for (const k of r.misplaced) lines.push(`  - ${k} thuộc schema nhưng nằm TRÊN phần tra từ`);
  for (const i of r.invalid) lines.push(`  - giá trị ví dụ không hợp lệ: ${i}`);
  return lines;
}

export function main(file: string = path.resolve(__dirname, '..', '.env.example')): number {
  const text = fs.readFileSync(file, 'utf8');
  const report = checkEnvExample(text, Object.keys(lookupEnvSchema.shape));
  if (report.ok) {
    console.log(`check-env-example: OK (${Object.keys(lookupEnvSchema.shape).length} biến của schema khớp .env.example)`);
    return 0;
  }
  console.error('check-env-example: .env.example không khớp config/lookup.ts:');
  for (const line of describeReport(report)) console.error(line);
  return 1;
}

if (require.main === module) process.exit(main());
