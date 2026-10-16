module.exports = [
  {
    file: 'tests/config/envExample.test.ts',
    edits: [
      [
        `describe('the real .env.example', () => {`,
        `describe('checkEnvExample — example values must be the defaults', () => {
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

describe('the real .env.example', () => {`,
      ],
      [
        `  it('a variable removed from the example would be caught', () => {`,
        `  it('documents the safe default of the publish policy (spec 1.5): review', () => {
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

  it('a variable removed from the example would be caught', () => {`,
      ],
    ],
  },
];
