module.exports = [
  {
    file: 'tests/acceptance/evaluate.test.ts',
    edits: [
      [
        `H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam'] });
    expect(ALL_ACCEPTANCE_WORDS).toHaveLength(43);
    expect(new Set(ALL_ACCEPTANCE_WORDS).size).toBe(43); // no word twice, in a group or between a group and a stand-in`,
        `H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam', 'ring', 'spring', 'bat', 'mint', 'pound', 'row', 'wave', 'well', 'yard', 'fan', 'tap', 'rock', 'bear', 'pool'] });
    expect(ALL_ACCEPTANCE_WORDS).toHaveLength(57);
    expect(new Set(ALL_ACCEPTANCE_WORDS).size).toBe(57); // no word twice, in a group or between a group and a stand-in`,
      ],
    ],
  },
  {
    file: 'tests/acceptance/report.test.ts',
    edits: [
      [
        `    waits: [],
    breakerResetMs: 30_000,`,
        `    waits: [],
    wordChecks: [],
    breakerResetMs: 30_000,`,
      ],
      [
        `describe('buildReport — a wait for the circuit breaker', () => {`,
        `describe('buildReport — group H words asked about again', () => {
  it('shows what Free Dictionary said about each word, and what that means for the verdict', () => {
    const text = buildReport(
      summary([word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: true }, true)], {
        wordChecks: [
          { word: 'crane', outcome: 'has' },
          { word: 'zzword', outcome: 'absent' },
          { word: 'bolt', outcome: 'error' },
        ],
      })
    );
    expect(text).toContain('| crane | có dữ liệu (200) | lúc tra máy chủ không nhận được gì: nguồn chập chờn, từ không sai; không đánh giá được |');
    expect(text).toContain('| zzword | 404 | nguồn không có từ này; câu trả lời rỗng là đúng và từ này chọn không hợp (không đạt) |');
    expect(text).toContain('| bolt | không trả lời | nguồn vẫn lỗi; không đánh giá được |');
  });

  it('says nothing about it when no word needed asking', () => {
    expect(buildReport(summary([]))).not.toContain('được hỏi lại ĐÚNG từ đó');
  });
});

describe('buildReport — a wait for the circuit breaker', () => {`,
      ],
    ],
  },
  {
    file: 'tests/acceptance/source.test.ts',
    edits: [
      [
        `import {
  breakerLikelyOpen,
  breakerWaitMs,
  describeProbe,`,
        `import {
  breakerLikelyOpen,
  breakerWaitMs,
  classifyWordCheck,
  describeProbe,`,
      ],
      [
        `  it('the rerun command lists only the groups`,
        `  it('asked again about ONE word: "has" means the source failed when the server looked, "absent" means the word is simply not there', () => {
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'has')).toMatchObject({ unhealthy: true, why: expect.stringContaining('có dữ liệu') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'error')).toMatchObject({ unhealthy: true, why: expect.stringContaining('vẫn không trả lời') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'absent')).toMatchObject({ unhealthy: false, why: expect.stringContaining('404') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, null).unhealthy).toBe(false);
    // the probes and the breaker still come first
    expect(sourceHealthFor({ probeHealthy: false, breakerOpen: false }, true, 'absent').unhealthy).toBe(true);
  });

  it('classifies the answer of the single-word look', () => {
    expect(classifyWordCheck({ ok: true, status: 200, ms: 90, error: null })).toBe('has');
    expect(classifyWordCheck({ ok: false, status: 404, ms: 90, error: 'http_404' })).toBe('absent');
    expect(classifyWordCheck({ ok: false, status: 503, ms: 90, error: 'http_503' })).toBe('error');
    expect(classifyWordCheck({ ok: false, status: null, ms: 2500, error: 'timeout' })).toBe('error');
    expect(classifyWordCheck(undefined)).toBe('error');
  });

  it('the rerun command lists only the groups`,
      ],
      [
        `describe('reclassifyForSource', () => {`,
        `describe('probeFreeDictionary for one word (the look after the fast path)', () => {
  it('asks for THAT word once, and a 404 is "absent", not a failure of the source', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ title: 'No Definitions Found' }), { status: 404 })) as unknown as typeof fetch;
    const r = await probeFreeDictionary('https://fd.test/en', 2500, { fetchImpl, sleep: async () => undefined }, 'zzword', 1);
    expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(1);
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe('https://fd.test/en/zzword');
    expect(classifyWordCheck(r.attempts[0])).toBe('absent');
  });
});

describe('reclassifyForSource', () => {`,
      ],
      [
        `  it('H: a wrong status or source is a failure even while Free Dictionary is down', () => {`,
        `  it('H: the same empty answer is unevaluable when Free Dictionary has the word now (it was failing), and a failure when it truly lacks it', () => {
    const gone = sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'has');
    const lacks = sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'absent');
    expect(judge('H', 'crane', noFreeDictionary(), gone).verdict).toBe('unevaluable');
    expect(judge('H', 'crane', noFreeDictionary(), lacks).verdict).toBe('fail');
  });

  it('H: a wrong status or source is a failure even while Free Dictionary is down', () => {`,
      ],
    ],
  },
];
