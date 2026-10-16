module.exports = [
  {
    file: 'tests/lookup/serviceHarness.ts',
    edits: [
      [
        `  refProbeThrows?: boolean;
  failInserts?: boolean;
}`,
        `  refProbeThrows?: boolean;
  failInserts?: boolean;
  /** word_lookups inserts wait for this before they finish (a slow database). */
  insertGate?: Promise<unknown>;
}`,
      ],
      [
        `        if (opts.failInserts) throw new Error('insert failed');
        lookups.push(params);`,
        `        if (opts.failInserts) throw new Error('insert failed');
        if (opts.insertGate) await opts.insertGate;
        lookups.push(params);`,
      ],
      [
        `  enqueueThrows?: boolean;
  limiter?`,
        `  enqueueThrows?: boolean;
  /** The job send waits for this before it answers (a slow queue). */
  enqueueGate?: Promise<unknown>;
  limiter?`,
      ],
      [
        `    if (opts.enqueueThrows) throw new Error('queue down');
    return`,
        `    if (opts.enqueueThrows) throw new Error('queue down');
    if (opts.enqueueGate) await opts.enqueueGate;
    return`,
      ],
    ],
  },
  {
    file: 'tests/lookup/lookupService.test.ts',
    edits: [
      // the 503 test: wait for the background work instead of one macrotask
      [
        `    await expect(h.service.lookup(input('serendipity'))).resolves.toEqual({ kind: 'unavailable' });
    await flush();
    expect(h.db.lookups[0].slice(1, 4)).toEqual([null, 'serendipity', 'not_found']);`,
        `    await expect(h.service.lookup(input('serendipity'))).resolves.toEqual({ kind: 'unavailable' });
    await h.service.idle();
    expect(h.db.lookups[0].slice(1, 4)).toEqual([null, 'serendipity', 'not_found']);`,
      ],
      // F11 tests that looked at the queue right after the answer
      [
        `    expect(r.body.enrichment).toEqual({ status: 'queued' });
    expect(h.enqueue).toHaveBeenCalledWith({ word: 'hello', requestedBy: 'user-1', ebookId: 'ebook-1', startAfterSeconds: undefined });`,
        `    expect(r.body.enrichment).toEqual({ status: 'queued' });
    await h.service.idle(); // the send happens after the answer (spec 1.5)
    expect(h.enqueue).toHaveBeenCalledWith({ word: 'hello', requestedBy: 'user-1', ebookId: 'ebook-1', startAfterSeconds: undefined });`,
      ],
      [
        `    const r: any = await h.service.lookup(input('zorp'));
    expect(h.enqueue).toHaveBeenCalled();
    expect(r.body.enrichment.status).toBe('queued');`,
        `    const r: any = await h.service.lookup(input('zorp'));
    await h.service.idle();
    expect(h.enqueue).toHaveBeenCalled();
    expect(r.body.enrichment.status).toBe('queued');`,
      ],
      [
        `  it('a queue failure is logged and reported, but never breaks the response', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueThrows: true });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.kind).toBe('temporary');
    expect(r.body.enrichment).toEqual({ status: 'skipped', reason: 'queue_error' });
    spy.mockRestore();
  });

  it('passes already_queued through', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueResult: { status: 'already_queued' } });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.enrichment.status).toBe('already_queued');
  });
});`,
        `  it('a queue failure never breaks the response (the details are in the background tests below)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueThrows: true });
    const r: any = await h.service.lookup(input('hello'));
    await h.service.idle();
    expect(r.kind).toBe('temporary');
    expect(r.body.enrichment).toEqual({ status: 'queued' }); // decided before the send, and not changed by what happens to it
    spy.mockRestore();
  });
});

// Spec 1.5: the job send (F11) and the word_lookups insert (F12) happen after the answer has been handed over.
describe('F11 / F12 run after the response', () => {
  /** A promise that is opened by hand. */
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };
  /** True while background work is still running one macrotask after the answer. */
  const stillRunning = async (service: { idle(): Promise<void> }) => (await Promise.race([service.idle().then(() => false), flush().then(() => true)])) === true;
  const lines = (h: { logs: Record<string, unknown>[] }, evt: string) => h.logs.filter((l) => l.evt === evt);
  const spyErr = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

  it('the answer does not wait for a job send that is still running when it arrives', async () => {
    const g = gate();
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueGate: g.promise });

    const r: any = await h.service.lookup(input('hello'));
    expect(r.kind).toBe('temporary');
    expect(r.body.enrichment).toEqual({ status: 'queued' });
    expect(lines(h, 'lookup')).toHaveLength(1); // the lookup is already logged, with the status the answer carries
    expect(lines(h, 'lookup')[0]).toMatchObject({ outcome: 'temporary', enrichment_status: 'queued' });

    expect(await stillRunning(h.service)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledTimes(1); // it has started and has not finished
    expect(lines(h, 'lookup_enrich')).toEqual([]);

    g.open();
    await h.service.idle();
    expect(lines(h, 'lookup_enrich')).toEqual([{ evt: 'lookup_enrich', word: 'hello', status: 'queued', reason: null, delayed_s: null, enqueue_ms: expect.any(Number) }]);
  });

  it('the 503 does not wait for the delayed job either, and its log says the job was deferred', async () => {
    const g = gate();
    const h = makeHarness({
      config: { enrichmentEnabled: true },
      db: { refKnown: () => true },
      fd: async () => {
        throw downErr();
      },
      google: async () => {
        throw downErr('google_translate');
      },
      enqueueGate: g.promise,
    });

    await expect(h.service.lookup(input('serendipity'))).resolves.toEqual({ kind: 'unavailable' });
    expect(lines(h, 'lookup')[0]).toMatchObject({ outcome: 'unavailable', enrichment_status: 'deferred' });
    expect(await stillRunning(h.service)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledWith({ word: 'serendipity', requestedBy: 'user-1', ebookId: 'ebook-1', startAfterSeconds: OUTAGE_JOB_DELAY_SECONDS });

    g.open();
    await h.service.idle();
    expect(lines(h, 'lookup_enrich')[0]).toMatchObject({ word: 'serendipity', status: 'queued', delayed_s: OUTAGE_JOB_DELAY_SECONDS });
  });

  it('after a 503, a word nobody vouches for gets no job, and that is logged', async () => {
    const h = makeHarness({
      config: { enrichmentEnabled: true },
      db: { refKnown: () => false },
      fd: async () => {
        throw downErr();
      },
      google: async () => {
        throw downErr('google_translate');
      },
    });
    await expect(h.service.lookup(input('qwxz'))).resolves.toEqual({ kind: 'unavailable' });
    await h.service.idle();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(lines(h, 'lookup_enrich')).toEqual([{ evt: 'lookup_enrich', word: 'qwxz', status: 'skipped', reason: 'unknown_word', delayed_s: OUTAGE_JOB_DELAY_SECONDS }]);
  });

  it('a send that fails never reaches the answer: one structured error line, and the NEXT lookup of the word sends again', async () => {
    const err = spyErr();
    const h = makeHarness({ config: { enrichmentEnabled: true } });
    h.enqueue.mockRejectedValueOnce(new Error('queue down'));

    const first: any = await h.service.lookup(input('hello'));
    await h.service.idle();
    expect(first.kind).toBe('temporary');
    expect(first.body.enrichment).toEqual({ status: 'queued' });
    expect(first.body.partial).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(err.mock.calls[0][0] as string)).toEqual({ evt: 'lookup_background_error', task: 'enrich', word: 'hello', error: 'queue down' });
    expect(lines(h, 'lookup_enrich')).toEqual([]); // no success line for a failure

    // the word is still not in the dictionary, so the next lookup tries to send the job again
    const second: any = await h.service.lookup(input('hello'));
    await h.service.idle();
    expect(second.kind).toBe('temporary');
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(1); // the second send worked
    expect(lines(h, 'lookup_enrich')).toHaveLength(1);
    err.mockRestore();
  });

  it('the error line of a failed send holds no secret', async () => {
    const err = spyErr();
    const h = makeHarness({ config: { enrichmentEnabled: true } });
    h.enqueue.mockRejectedValueOnce(new Error('send failed: x-api-key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and ?key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY1234'));
    await h.service.lookup(input('hello'));
    await h.service.idle();
    const line = String(err.mock.calls[0][0]);
    expect(line).toContain('lookup_background_error');
    expect(line).not.toContain('sk-ant-api03');
    expect(line).not.toContain('AIzaSy');
    err.mockRestore();
  });

  it('what the send really answered is logged, whatever the answer said: already_queued and the daily cap', async () => {
    for (const result of [{ status: 'already_queued' as const }, { status: 'skipped' as const, reason: 'daily_cap' }]) {
      const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueResult: result });
      const r: any = await h.service.lookup(input('hello'));
      await h.service.idle();
      expect(r.body.enrichment).toEqual({ status: 'queued' });
      expect(lines(h, 'lookup_enrich')[0]).toMatchObject({ word: 'hello', status: result.status, reason: (result as any).reason ?? null });
    }
  });

  it('a word that is not trusted is still answered as skipped / unknown_word, before and without any send', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, fd: async () => FD_404, db: { refKnown: () => false } });
    const r: any = await h.service.lookup(input('zorp'));
    expect(r.body.enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
    await h.service.idle();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(lines(h, 'lookup_enrich')).toEqual([]);
  });

  it('word_lookups: a slow insert does not hold the answer, and the row is the one written before the change', async () => {
    const g = gate();
    const h = makeHarness({ db: { insertGate: g.promise } });

    const r: any = await h.service.lookup(input('Zorp'));
    expect(r.kind).toBe('temporary');
    expect(await stillRunning(h.service)).toBe(true);
    expect(h.db.lookups).toEqual([]); // not written yet

    g.open();
    await h.service.idle();
    expect(h.db.lookups).toEqual([['user-1', null, 'Zorp', 'translation', 'ebook-1', null]]);
  });

  it('word_lookups: every outcome still writes its row (dictionary, translation, not_found), after the answer', async () => {
    const hit = makeHarness({ db: { local: () => ENTRY } });
    await hit.service.lookup(input('run'));
    expect(hit.db.lookups).toEqual([]); // the answer is out before the insert starts
    await hit.service.idle();
    expect(hit.db.lookups).toEqual([['user-1', 'entry-1', 'run', 'dictionary', 'ebook-1', null]]);

    const temp = makeHarness();
    await temp.service.lookup(input('Zorp'));
    await temp.service.idle();
    expect(temp.db.lookups).toEqual([['user-1', null, 'Zorp', 'translation', 'ebook-1', null]]);

    const none = makeHarness({ fd: async () => FD_404, google: async () => { throw downErr('google_translate'); } });
    await none.service.lookup(input('qwxz'));
    await none.service.idle();
    expect(none.db.lookups).toEqual([['user-1', null, 'qwxz', 'not_found', 'ebook-1', null]]);
  });

  it('word_lookups: a failing insert is one structured error line and changes nothing about the answer', async () => {
    const err = spyErr();
    const h = makeHarness({ db: { failInserts: true } });
    const r: any = await h.service.lookup(input('Zorp'));
    await h.service.idle();
    expect(r.kind).toBe('temporary');
    expect(r.body.translation_vi).toBe('chào');
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(err.mock.calls[0][0] as string)).toEqual({ evt: 'lookup_background_error', task: 'word_lookups', word: 'zorp', error: 'insert failed' });
    err.mockRestore();
  });

  it('a job send that fails does not stop the word_lookups insert, and the other way round', async () => {
    const err = spyErr();
    const h = makeHarness({ config: { enrichmentEnabled: true }, db: { failInserts: true } });
    h.enqueue.mockRejectedValueOnce(new Error('queue down'));
    await h.service.lookup(input('hello'));
    await h.service.idle();
    expect(err.mock.calls.map((c) => JSON.parse(c[0] as string).task).sort()).toEqual(['enrich', 'word_lookups']);
    err.mockRestore();
  });

  it('the dictionary path and the other early exits start no job and no external call', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true, translationFallbackEnabled: false }, db: { local: () => undefined } });
    await expect(h.service.lookup(input('zorp'))).resolves.toEqual({ kind: 'not_found' });
    await h.service.idle();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.db.lookups).toEqual([['user-1', null, 'zorp', 'not_found', 'ebook-1', null]]);
  });
});`,
      ],
    ],
  },
];
