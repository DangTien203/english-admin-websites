module.exports = [
  {
    file: 'tests/chaos/upstream.chaos.test.ts',
    edits: [
      [
        `  beforeAll(() => {
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
  afterAll(() => jest.restoreAllMocks());`,
        `  let infoSpy: jest.SpyInstance;
  beforeAll(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation((line: unknown) => {
      try {
        const parsed = JSON.parse(String(line));
        if (parsed.evt === 'lookup_enrich') enrichLines.push(parsed);
      } catch {
        /* not a JSON log line */
      }
    });
  });
  afterAll(() => infoSpy.mockRestore());`,
      ],
    ],
  },
];
