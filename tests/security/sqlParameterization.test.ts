/**
 * Static audit (docs/lookup-spec.md §12.3, P7): every SQL statement written for the lookup, the queue and the enrichment code is
 * parameterized. The test reads the source, finds every template literal that holds SQL and has a ${…} in it, and compares the
 * list with the allowlist below. A new interpolation in SQL fails the test until someone reads it and adds it here with a reason.
 *
 * What is allowed to be spliced into SQL: a constant written in the code (a LIMIT, a shared projection), a placeholder number
 * ($1, $2…), a pg-boss schema name that was checked against a plain-identifier pattern, or a fixed fragment chosen by a boolean.
 * Never a value that comes from a request, a provider, a queue payload or a file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Directories and files that hold the SQL written for P2–P7. */
const SCOPE = [
  'services/lookup',
  'services/upstream',
  'services/enrichment',
  'services/queue',
  'models/EnrichmentJob.ts',
  'routes/api/ebooks.ts', // only the lookup handler, see sourceOf()
  'utils/entryQueries.ts',
  'config',
  'scripts/enrichment',
  'scripts/mock-upstream',
  'database/migrations/33_lookup_foundation.ts',
  'database/refdata',
];

/** Interpolations that are fine, with the reason. Key: file → the text between ${ and }. */
const ALLOWED: Record<string, Record<string, string>> = {
  'services/lookup/localLookup.ts': { FULL_ENTRY_SQL: 'a constant projection (utils/entryQueries.ts); the word itself is $1' },
  'services/lookup/health.ts': { schema: 'the pg-boss schema from PGBOSS_SCHEMA, checked against /^[a-z_][a-z0-9_]{0,62}$/i immediately before use (and by zod at start-up)' },
  'services/queue/redrive.ts': { 'deps.schema': 'same: the schema name is checked against the identifier pattern at the top of planRedrive; words and ids are $2/$3' },
  'services/enrichment/persist.ts': { FAMILY_MEMBERS_MAX: 'a numeric constant in the code' },
  'services/enrichment/sources/wiktionary.ts': { WIKTIONARY_ROW_LIMIT: 'a numeric constant in the code' },
  'models/EnrichmentJob.ts': {
    where: 'either empty or the fixed text "WHERE word = $N"; the value itself is a bound parameter',
    'params.length': 'builds the placeholder number ($1, $2…)',
  },
  'scripts/enrichment/review.ts': { "onlyUnpublished ? 'AND e.published = FALSE' : ''": 'a fixed fragment chosen by a boolean command-line flag' },
};

const SQL_WORDS = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TABLE|ALTER\s+TABLE|WITH\s+\w+\s+AS)\b/;

interface Literal {
  text: string;
  expressions: string[];
}

/** Template literals of a TypeScript source, with the text of their ${…} expressions (nested templates handled). */
function templateLiterals(source: string): Literal[] {
  const found: Literal[] = [];
  const readTemplate = (start: number): { end: number; literal: Literal } => {
    // source[start] === '`'
    let i = start + 1;
    let text = '';
    const expressions: string[] = [];
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') return { end: i + 1, literal: { text, expressions } };
      if (ch === '$' && source[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        let expr = '';
        while (j < source.length && depth > 0) {
          const c = source[j];
          if (c === '`') {
            const nested = readTemplate(j);
            found.push(nested.literal);
            expr += source.slice(j, nested.end);
            j = nested.end;
            continue;
          }
          if (c === '{') depth++;
          if (c === '}') depth--;
          if (depth > 0) expr += c;
          j++;
        }
        expressions.push(expr.trim());
        text += '${…}';
        i = j;
        continue;
      }
      text += ch;
      i++;
    }
    return { end: i, literal: { text, expressions } };
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
    } else if (ch === '`') {
      const r = readTemplate(i);
      found.push(r.literal);
      i = r.end - 1;
    }
  }
  return found;
}

function filesOf(entry: string): string[] {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [entry];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesOf(path.join(entry, d.name)) : /\.(ts|mts)$/.test(d.name) ? [path.join(entry, d.name)] : []));
}

const files = SCOPE.flatMap(filesOf).map((f) => f.split(path.sep).join('/'));

/**
 * The source to audit for a file. routes/api/ebooks.ts also holds older endpoints (the ebook list builds its WHERE from fixed
 * templates with $IDX placeholders; not part of this feature), so for that file only the lookup handler is read.
 */
function sourceOf(file: string): string {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file !== 'routes/api/ebooks.ts') return source;
  const start = source.indexOf("'/:id/lookup'");
  const end = source.indexOf("'/:id/translate-paragraph'");
  if (start < 0 || end < start) throw new Error('the lookup handler was not found in routes/api/ebooks.ts');
  return source.slice(start, end);
}

describe('SQL written for the lookup, queue and enrichment code', () => {
  it('the scan itself finds what it should (guards against the audit silently checking nothing)', () => {
    expect(files).toEqual(expect.arrayContaining(['services/lookup/localLookup.ts', 'services/queue/redrive.ts', 'models/EnrichmentJob.ts', 'services/enrichment/persist.ts']));
    const total = files.reduce((n, f) => n + templateLiterals(sourceOf(f)).filter((l) => SQL_WORDS.test(l.text)).length, 0);
    expect(total).toBeGreaterThan(40); // dozens of statements are written in this scope
  });

  it('every ${…} inside a SQL template literal is on the allowlist, with a reason', () => {
    const unexpected: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      for (const literal of templateLiterals(sourceOf(file))) {
        if (!SQL_WORDS.test(literal.text) || literal.expressions.length === 0) continue;
        for (const expr of literal.expressions) {
          // "$${n}" in the source is a literal "$" followed by ${n}: a placeholder number, built from an array length
          const ok = ALLOWED[file]?.[expr];
          if (ok) used.add(`${file}::${expr}`);
          else unexpected.push(`${file}: \${${expr}}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
    // an allowlist entry nobody uses any more is dead weight: remove it
    const declared = Object.entries(ALLOWED).flatMap(([f, m]) => Object.keys(m).map((e) => `${f}::${e}`));
    expect(declared.filter((d) => !used.has(d))).toEqual([]);
  });

  it('no SQL is built by concatenating strings (" + " next to a SQL keyword inside a .query call)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = sourceOf(file);
      const re = /\.query\(\s*(['"])(?:(?!\1).)*\1\s*\+/g;
      if (re.test(source)) offenders.push(file);
      if (/\.query\([^)]*\+\s*(?:req|input|word|params)\b/.test(source)) offenders.push(`${file} (concatenated value)`);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowed identifier splice really is guarded: both places reject a hostile schema name', async () => {
    const { planRedrive } = await import('../../services/queue/redrive');
    const { LookupHealthService } = await import('../../services/lookup/health');
    const hostile = 'pgboss"; DROP TABLE users; --';
    await expect(planRedrive({ db: { query: async () => ({ rows: [] }) }, schema: hostile })).rejects.toThrow('invalid queue schema name');
    const health = await new LookupHealthService({ db: { query: async () => ({ rows: [] }) }, breakers: () => ({}), limits: { googleMonthlyChars: 1, maxJobsPerDay: 1 }, queueSchema: hostile }).getSnapshot();
    expect(health.queue).toEqual({ error: 'invalid queue schema name' });
  });
});
