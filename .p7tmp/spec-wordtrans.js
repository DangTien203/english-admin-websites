module.exports = [
  {
    file: 'tests/word-translation.test.ts',
    edits: [
      // imports
      [
        `import { normalizeWord } from '../services/wordTranslationService';
`,
        `import { normalizeWord } from '../services/wordTranslationService';
import { bootLookupApp } from './helpers/lookupApp';
`,
      ],
      // the fetch stub: Google answers with as many translations as it was sent texts
      [
        `function stubFetch(opts: {
  google?: { body: unknown; status?: number } | 'reject';`,
        `function stubFetch(opts: {
  /** \`body\` may be a function of the texts sent: the real API returns one translation per text (headline, then the definitions). */
  google?: { body: unknown | ((q: string[]) => unknown); status?: number } | 'reject';`,
      ],
      [
        `  const fetchFn = jest.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('translation.googleapis.com')) {
      if (opts.google === 'reject') throw new Error('network down');
      if (!opts.google) return fakeResponse({}, 200);
      return fakeResponse(opts.google.body, opts.google.status ?? 200);
    }`,
        `  const fetchFn = jest.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('translation.googleapis.com')) {
      if (opts.google === 'reject') throw new Error('network down');
      if (!opts.google) return fakeResponse({}, 200);
      const body = typeof opts.google.body === 'function' ? opts.google.body(JSON.parse(String(init?.body ?? '{}')).q ?? []) : opts.google.body;
      return fakeResponse(body, opts.google.status ?? 200);
    }`,
      ],
      // the cache-miss test
      [
        `  test('cache miss: parallel calls, returns source=translation cached=false', async () => {
    const fetchStub = stubFetch({
      google: {
        body: { data: { translations: [{ translatedText: 'từ thử nghiệm' }] } },
      },
      freeDict: {
        body: [
          {
            phonetic: '/test/',`,
        `  test('a miss asks both providers: source=translation, cached=false', async () => {
    const fetchStub = stubFetch({
      google: {
        // one translation per text sent: the bare word, then "word: definition" for the definitions
        body: (q) => ({ data: { translations: q.map((text) => ({ translatedText: text.includes(': ') ? 'từ thử nghiệm: một từ dùng để thử' : 'từ thử nghiệm' })) } }),
      },
      freeDict: {
        body: [
          {
            // a real Free Dictionary entry always carries its headword
            word: FALLBACK_WORD,
            phonetic: '/test/',`,
      ],
      [
        `    expect(res.body.data.cached).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });`,
        `    expect(res.body.data.cached).toBe(false);
    // Google (the word), Free Dictionary, then Google again for the definition of the sense (spec §5 F8 / F9)
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });`,
      ],
      // the two cache tests become "there is no cache"
      [
        `  test('cache hit on second call: cached=true, no external calls', async () => {
    // Sanity: cache row should exist from previous test.
    const { rows: cached } = await pool.query(
      \`SELECT word FROM word_translation_cache WHERE word = $1\`,
      [FALLBACK_WORD.toLowerCase()]
    );
    expect(cached.length).toBe(1);

    const fetchStub = stubFetch({});
    const res = await request(app)
      .post(\`/api/v1/ebooks/\${ebookId}/lookup\`)
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ word: FALLBACK_WORD });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.cached).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });`,
        `  // docs/lookup-spec.md §3 and §5 F7: word_translation_cache is neither read nor written any more, and a temporary answer is
  // never cached. (This test used to expect the opposite: cached=true and no outside call on the second lookup.)
  test('there is no cache: the second lookup asks the providers again, and nothing is written to word_translation_cache', async () => {
    const { rows: cachedBefore } = await pool.query(\`SELECT word FROM word_translation_cache WHERE word = $1\`, [FALLBACK_WORD.toLowerCase()]);
    expect(cachedBefore).toEqual([]);

    const fetchStub = stubFetch({
      google: { body: (q) => ({ data: { translations: q.map((t) => ({ translatedText: t.includes(': ') ? 'từ thử nghiệm: một từ' : 'từ thử nghiệm' })) } }) },
      freeDict: { body: [{ word: FALLBACK_WORD, phonetic: '/test/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A test word.' }] }] }] },
    });
    const res = await request(app)
      .post(\`/api/v1/ebooks/\${ebookId}/lookup\`)
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ word: FALLBACK_WORD });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.cached).toBe(false);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetchStub).toHaveBeenCalled();

    const { rows } = await pool.query(\`SELECT word FROM word_translation_cache WHERE word = $1\`, [FALLBACK_WORD.toLowerCase()]);
    expect(rows).toEqual([]);
  });`,
      ],
      [
        `  test('punctuation around word still hits translation cache (normalize first)', async () => {
    const fetchStub = stubFetch({});
    const res = await request(app)
      .post(\`/api/v1/ebooks/\${ebookId}/lookup\`)
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ word: \`\${FALLBACK_WORD},\` });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.cached).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });`,
        `  test('punctuation around the word is stripped before the lookup (the providers are asked for the clean word)', async () => {
    const fetchStub = stubFetch({
      google: { body: (q) => ({ data: { translations: q.map((t) => ({ translatedText: t.includes(': ') ? 'từ thử nghiệm: một từ' : 'từ thử nghiệm' })) } }) },
      freeDict: { body: [{ word: FALLBACK_WORD, phonetic: '/test/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A test word.' }] }] }] },
    });
    const res = await request(app)
      .post(\`/api/v1/ebooks/\${ebookId}/lookup\`)
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ word: \`\${FALLBACK_WORD},\` });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.word).toBe(FALLBACK_WORD);
    const urls = fetchStub.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(\`/\${FALLBACK_WORD.toLowerCase()}\`) && !u.includes(','))).toBe(true);
  });`,
      ],
      // the fallback switch
      [
        `  test('404 ENTRY_NOT_FOUND when TRANSLATION_FALLBACK_ENABLED is off', async () => {
    process.env.TRANSLATION_FALLBACK_ENABLED = 'false';
    const fetchStub = stubFetch({});
    try {
      const res = await request(app)
        .post(\`/api/v1/ebooks/\${ebookId}/lookup\`)
        .set('Authorization', \`Bearer \${access_token}\`)
        .send({ word: DISABLED_WORD });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      process.env.TRANSLATION_FALLBACK_ENABLED = 'true';
    }
  });`,
        `  // The switch is read ONCE, when the app starts (config/lookup.ts validates and freezes the environment), so flipping
  // process.env here, as this test used to, changes nothing. The app is started with the switch off instead; the mock upstream
  // server proves that no outside request is made. (Also covered by tests/e2e/lookup.e2e.test.ts.)
  test('404 ENTRY_NOT_FOUND when TRANSLATION_FALLBACK_ENABLED is off', async () => {
    const off = await bootLookupApp({ env: { TRANSLATION_FALLBACK_ENABLED: 'false' } });
    try {
      const res = await off.lookup(DISABLED_WORD);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
      expect(off.mock.stats().total).toBe(0);
    } finally {
      await off.close();
    }
  });`,
      ],
    ],
  },
  {
    file: 'tests/ebooks.test.ts',
    edits: [
      [
        `import pool from '../config/db';
`,
        `import pool from '../config/db';
import { bootLookupApp } from './helpers/lookupApp';
`,
      ],
      [
        `  it('returns 404 for unknown word (with TRANSLATION_FALLBACK_ENABLED off)', async () => {
    // Make sure the translation fallback path isn't exercised by this test —
    // we only want to verify the dict-miss path returns 404.
    const orig = process.env.TRANSLATION_FALLBACK_ENABLED;
    process.env.TRANSLATION_FALLBACK_ENABLED = 'false';
    try {
      const res = await request(app)
        .post(\`/api/v1/ebooks/\${testEbookId}/lookup\`)
        .set('Authorization', \`Bearer \${access_token}\`)
        .send({ word: 'xyzzynosuchword' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
    } finally {
      if (orig === undefined) delete process.env.TRANSLATION_FALLBACK_ENABLED;
      else process.env.TRANSLATION_FALLBACK_ENABLED = orig;
    }
  });`,
        `  it('returns 404 for unknown word (with TRANSLATION_FALLBACK_ENABLED off)', async () => {
    // The switch is read once, at start-up (config/lookup.ts freezes the environment), so setting process.env inside a test has
    // no effect: this test used to do that, leave the fallback ON, and call the real Google and Free Dictionary. The app is
    // started with the switch off instead, against the local mock upstream server, which also proves no outside request is made.
    const off = await bootLookupApp({ env: { TRANSLATION_FALLBACK_ENABLED: 'false' } });
    try {
      const res = await off.lookup('xyzzynosuchword');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
      expect(off.mock.stats().total).toBe(0);
    } finally {
      await off.close();
    }
  });`,
      ],
    ],
  },
];
