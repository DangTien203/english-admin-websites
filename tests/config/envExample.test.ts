import fs from 'node:fs';
import path from 'node:path';
import { checkEnvExample, describeReport, parseEnvExample } from '../../scripts/check-env-example';
import { lookupEnvSchema } from '../../config/lookup';

const KEYS = ['A_ONE', 'A_TWO'];
const HEADER = '# ── Word lookup (docs/lookup-spec.md §1) ──';
const accept = () => ({}); // a loader that accepts anything

describe('parseEnvExample', () => {
  it('reads assignments, ignores comments and blank lines, and marks the lookup section', () => {
    const p = parseEnvExample(['PORT=3000', '', '# a comment', HEADER, 'A_ONE=1', '  A_TWO = two words ', '#COMMENTED=1'].join('\n'));
    expect(p.markerMissing).toBe(false);
    expect(p.entries).toEqual([
      { name: 'PORT', value: '3000', lookup: false },
      { name: 'A_ONE', value: '1', lookup: true },
      { name: 'A_TWO', value: 'two words', lookup: true },
    ]);
  });

  it('copes with CRLF line endings and says when the marker is missing', () => {
    const p = parseEnvExample('A_ONE=1\r\nA_TWO=2\r\n');
    expect(p.markerMissing).toBe(true);
    expect(p.entries.map((e) => e.name)).toEqual(['A_ONE', 'A_TWO']);
  });
});

describe('checkEnvExample', () => {
  const good = [HEADER, 'A_ONE=1', 'A_TWO=2'].join('\n');

  it('passes when the lookup section lists exactly the schema variables', () => {
    expect(checkEnvExample(good, KEYS, accept)).toMatchObject({ ok: true, missing: [], extra: [], duplicates: [], misplaced: [], invalid: [] });
  });

  it('fails with the MISSING variable', () => {
    const r = checkEnvExample([HEADER, 'A_ONE=1'].join('\n'), KEYS, accept);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['A_TWO']);
    expect(describeReport(r)).toEqual(['  - THIẾU trong .env.example: A_TWO']);
  });

  it('fails with the EXTRA variable (a typo shows up as one missing and one extra)', () => {
    const r = checkEnvExample([HEADER, 'A_ONE=1', 'A_TW=2'].join('\n'), KEYS, accept);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['A_TWO']);
    expect(r.extra).toEqual(['A_TW']);
  });

  it('fails on a duplicated variable', () => {
    const r = checkEnvExample([HEADER, 'A_ONE=1', 'A_TWO=2', 'A_ONE=3'].join('\n'), KEYS, accept);
    expect(r.ok).toBe(false);
    expect(r.duplicates).toEqual(['A_ONE']);
  });

  it('fails when a schema variable sits above the lookup section (it would not be checked there)', () => {
    const r = checkEnvExample(['A_ONE=1', HEADER, 'A_ONE=1', 'A_TWO=2'].join('\n'), KEYS, accept);
    expect(r.ok).toBe(false);
    expect(r.misplaced).toEqual(['A_ONE']);
  });

  it('ignores application variables above the section (PORT, DB_*, …)', () => {
    expect(checkEnvExample(['PORT=3000', 'DB_HOST=localhost', good].join('\n'), KEYS, accept).ok).toBe(true);
  });

  it('fails without the marker line', () => {
    const r = checkEnvExample('A_ONE=1\nA_TWO=2', KEYS, accept);
    expect(r.ok).toBe(false);
    expect(r.markerMissing).toBe(true);
  });

  it('fails when the example values do not load, and reports names but no values', () => {
    const r = checkEnvExample(good, KEYS, () => {
      const { LookupConfigError } = jest.requireActual('../../config/lookup');
      throw new LookupConfigError(['A_ONE: must be an integer']);
    });
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['A_ONE: must be an integer']);
  });
});

describe('checkEnvExample — example values must be the defaults', () => {
  const good = [HEADER, 'A_ONE=1', 'A_TWO=2'].join('\n');
  // a parser with one default (A_ONE=1) and a number-typed value, like the real schema
  const parse = (env: Record<string, string>) => ({ A_ONE: Number(env.A_ONE ?? '1'), A_TWO: env.A_TWO ?? '2' });

  it('passes when every example value parses to the default', () => {
    const r = checkEnvExample([HEADER, 'A_ONE=01', 'A_TWO=2'].join('\n'), KEYS, accept, parse);
    expect(r.notDefault).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails with the NAME of a variable whose example value is not the default, and prints no value', () => {
    const r = checkEnvExample([HEADER, 'A_ONE=1', 'A_TWO=secret-looking-value'].join('\n'), KEYS, accept, parse);
    expect(r.ok).toBe(false);
    expect(r.notDefault).toEqual(['A_TWO']);
    const lines = describeReport(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('A_TWO');
    expect(lines[0]).not.toContain('secret-looking-value');
  });

  it('is not reported twice when the values do not load at all', () => {
    const r = checkEnvExample(good, KEYS, () => { throw new Error('boom'); }, parse);
    expect(r.invalid).toHaveLength(1);
    expect(r.notDefault).toEqual([]);
  });
});

describe('the real .env.example', () => {
  const file = path.resolve(__dirname, '..', '..', '.env.example');
  const keys = Object.keys(lookupEnvSchema.shape);

  it('matches the configuration schema of config/lookup.ts exactly (no missing, extra, duplicate or invalid variable)', () => {
    const report = checkEnvExample(fs.readFileSync(file, 'utf8'), keys);
    expect(describeReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('lists every variable of docs/lookup-spec.md §1', () => {
    // 32 variables today; if this number changes, the spec, the schema and .env.example have to change together
    expect(keys.length).toBe(32);
    expect(keys).toEqual(expect.arrayContaining(['TRANSLATION_FALLBACK_ENABLED', 'ENRICHMENT_ENABLED', 'ENRICHMENT_WORKER_ENABLED', 'ENRICHMENT_PUBLISH_POLICY', 'DATAMUSE_API_KEY', 'REFDATA_DATABASE_URL']));
  });

  it('documents the safe default of the publish policy (spec 1.5): review', () => {
    const text = fs.readFileSync(file, 'utf8');
    expect(parseEnvExample(text).entries.find((e) => e.name === 'ENRICHMENT_PUBLISH_POLICY')).toMatchObject({ value: 'review', lookup: true });
  });

  it('every example value is the default of the schema, so a copy of the file behaves like an empty environment', () => {
    expect(checkEnvExample(fs.readFileSync(file, 'utf8'), keys).notDefault).toEqual([]);
  });

  it('a default that moved on without the example would be caught (the publish policy set to auto in the example)', () => {
    const text = fs.readFileSync(file, 'utf8').replace(/^ENRICHMENT_PUBLISH_POLICY=.*$/m, 'ENRICHMENT_PUBLISH_POLICY=auto');
    const r = checkEnvExample(text, keys);
    expect(r.ok).toBe(false);
    expect(r.notDefault).toEqual(['ENRICHMENT_PUBLISH_POLICY']);
  });

  it('a variable removed from the example would be caught', () => {
    const text = fs.readFileSync(file, 'utf8').replace(/^ENRICHMENT_MAX_JOBS_PER_DAY=.*$/m, '');
    expect(checkEnvExample(text, keys).missing).toEqual(['ENRICHMENT_MAX_JOBS_PER_DAY']);
  });
});
