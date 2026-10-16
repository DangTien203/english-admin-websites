module.exports = [
  {
    file: 'tests/helpers/lookupApp.ts',
    edits: [
      [
        `  /** Waits until \`fn\` returns something truthy. */`,
        `  /** Waits for what the service does AFTER an answer (the job send, the word_lookups insert; spec 1.5). */
  settle(): Promise<void>;
  /** Waits until \`fn\` returns something truthy. */`,
      ],
      [
        `    waitFor,
    async close() {`,
        `    waitFor,
    settle: () => lookupModule.getWordLookupService().idle(),
    async close() {`,
      ],
    ],
  },
  {
    file: 'tests/e2e/lookup.e2e.test.ts',
    edits: [
      [
        `    expect(enqueued).toEqual([{ word: w.fg, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: undefined }]);`,
        `    await a.settle(); // the job is sent after the answer
    expect(enqueued).toEqual([{ word: w.fg, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: undefined }]);`,
      ],
      [
        `    expect(enqueued.map((e) => e.word)).toEqual([w.fNoG]); // Free Dictionary knows it: a trusted word`,
        `    await a.settle();
    expect(enqueued.map((e) => e.word)).toEqual([w.fNoG]); // Free Dictionary knows it: a trusted word`,
      ],
      [
        `    expect(d.enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
    expect(enqueued).toEqual([]);`,
        `    expect(d.enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
    await a.settle();
    expect(enqueued).toEqual([]);`,
      ],
      [
        `    expect(res.headers['cache-control']).toBe('no-store');
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFd404)).lookup_result).toBe('not_found');`,
        `    expect(res.headers['cache-control']).toBe('no-store');
    await a.settle();
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFd404)).lookup_result).toBe('not_found');`,
      ],
      [
        `    expect(enqueued).toEqual([{ word: w.noGFdErr, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: 60 }]);`,
        `    await a.settle();
    expect(enqueued).toEqual([{ word: w.noGFdErr, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: 60 }]);`,
      ],
      [
        `    expect(res.status).toBe(503);
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFdErrUnknown)).lookup_result).toBe('not_found');
  });`,
        `    expect(res.status).toBe(503);
    await a.settle();
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFdErrUnknown)).lookup_result).toBe('not_found');
  });

  // Spec 1.5: the job send and the word_lookups insert run after the answer. The sender below can only finish when the test lets it,
  // so an answer that waited for it would never arrive (the test would time out instead of passing).
  it('the answer does not wait for the job send, and word_lookups is still written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: EnqueueInput[] = [];
    a.setEnqueuer({
      enqueue: async (input) => {
        sent.push(input);
        await gate;
        return { status: 'queued' };
      },
    });
    const word = fixtureWord('slowsend');
    try {
      const res = await a.lookup(word);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ source: 'translation', partial: false });
      expect(res.body.data.enrichment).toEqual({ status: 'queued' });
      await a.waitFor(async () => sent.length > 0, 'the background send to start');
      expect((await lookupRow(a, word)).lookup_result).toBe('translation'); // the insert does not queue behind the send either
    } finally {
      release();
      await a.settle();
      a.setEnqueuer({
        enqueue: async (input) => {
          enqueued.push(input);
          return { status: 'queued' };
        },
      });
    }
    expect(sent.map((s) => s.word)).toEqual([word]);
  });

  it('a send that throws leaves the answer and word_lookups alone and is reported as one structured error line', async () => {
    const errors = console.error as unknown as jest.Mock;
    a.setEnqueuer({
      enqueue: async () => {
        throw new Error('queue is down');
      },
    });
    const word = fixtureWord('sendfails');
    try {
      const before = errors.mock.calls.length;
      const res = await a.lookup(word);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ source: 'translation', partial: false, enrichment: { status: 'queued' } });
      await a.settle();
      expect((await lookupRow(a, word)).lookup_result).toBe('translation');
      const reported = errors.mock.calls
        .slice(before)
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return null;
          }
        })
        .filter((l) => l?.evt === 'lookup_background_error');
      expect(reported).toEqual([{ evt: 'lookup_background_error', task: 'enrich', word, error: 'queue is down' }]);
    } finally {
      a.setEnqueuer({
        enqueue: async (input) => {
          enqueued.push(input);
          return { status: 'queued' };
        },
      });
    }
  });`,
      ],
    ],
  },
];
