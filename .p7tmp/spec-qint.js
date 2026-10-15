module.exports = [
  {
    file: 'tests/queue/queue.integration.test.ts',
    edits: [
      [
        `    const [job] = await boss.findJobs(ENRICH_QUEUE, { key: word });
    expect(job.state).toBe('completed');
    expect(job.data).toEqual({ word, requestedBy: null, ebookId: null, jobRowId: row.id }); // exactly the four fields`,
        `    // The ledger row is written by the handler; pg-boss marks the job completed a moment AFTER the handler returns (on a database
    // that is far away that is a visible gap), so wait for it instead of reading the state once.
    const job = await waitFor(async () => {
      const [j] = await boss.findJobs(ENRICH_QUEUE, { key: word });
      return j?.state === 'completed' ? j : false;
    }, 'the pg-boss job to complete');
    expect(job.state).toBe('completed');
    expect(job.data).toEqual({ word, requestedBy: null, ebookId: null, jobRowId: row.id }); // exactly the four fields`,
      ],
    ],
  },
];
