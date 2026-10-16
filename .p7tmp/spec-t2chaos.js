module.exports = [
  {
    file: 'tests/chaos/upstream.chaos.test.ts',
    edits: [
      [
        `  it('the third word of the day is answered normally, with enrichment skipped / daily_cap, and no job exists for it', async () => {
    const words = ['capa', 'capb', 'capc'].map(fixtureWord);
    const answers = [];
    for (const word of words) answers.push((await a.lookup(word)).body.data.enrichment);

    expect(answers).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'skipped', reason: 'daily_cap' }]);
    expect(sent).toEqual([words[0], words[1]]);
    const { rows } = await a.pool.query(\`SELECT word FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word\`, [words]);
    expect(rows.map((r) => r.word)).toEqual([words[0], words[1]]);
  });

  it('the lookup itself is unaffected by the cap (complete answer, nothing missing)', async () => {
    const res = await a.lookup(fixtureWord('capd'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ partial: false, enrichment: { status: 'skipped', reason: 'daily_cap' } });
  });`,
        `  // Spec 1.5: the job is sent after the answer, so the answer says "queued" (decided before the send) and what the cap did is in the
  // ledger, in what was sent to pg-boss and in the \`lookup_enrich\` log line.
  const enrichLines: Array<Record<string, any>> = [];
  beforeAll(() => {
    const real = console.info.bind(console);
    jest.spyOn(console, 'info').mockImplementation((line: unknown) => {
      try {
        const parsed = JSON.parse(String(line));
        if (parsed.evt === 'lookup_enrich') enrichLines.push(parsed);
      } catch {
        /* not a JSON log line */
      }
      return real === undefined ? undefined : undefined;
    });
  });
  afterAll(() => jest.restoreAllMocks());

  it('the third word of the day is answered normally, no job exists for it, and the log says it hit the daily cap', async () => {
    const words = ['capa', 'capb', 'capc'].map(fixtureWord);
    const answers = [];
    for (const word of words) {
      answers.push((await a.lookup(word)).body.data.enrichment);
      await a.settle(); // one after the other, so the order in which the cap is used up is the order of the words
    }

    expect(answers).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    expect(sent).toEqual([words[0], words[1]]);
    const { rows } = await a.pool.query(\`SELECT word FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word\`, [words]);
    expect(rows.map((r) => r.word)).toEqual([words[0], words[1]]);
    expect(enrichLines.filter((l) => words.includes(l.word)).map((l) => [l.word, l.status, l.reason])).toEqual([
      [words[0], 'queued', null],
      [words[1], 'queued', null],
      [words[2], 'skipped', 'daily_cap'],
    ]);
  });

  it('the lookup itself is unaffected by the cap (complete answer, nothing missing)', async () => {
    const word = fixtureWord('capd');
    const res = await a.lookup(word);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ partial: false, enrichment: { status: 'queued' } });
    await a.settle();
    expect(enrichLines.find((l) => l.word === word)).toMatchObject({ status: 'skipped', reason: 'daily_cap' });
  });`,
      ],
    ],
  },
];
