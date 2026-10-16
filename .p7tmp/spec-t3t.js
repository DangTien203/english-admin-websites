module.exports = [
  {
    file: 'tests/acceptance/evaluate.test.ts',
    edits: [
      [
        "  planWords,\n  type Group,",
        "  planWords,\n  RUN_ORDER,\n  type Group,",
      ],
      [
        "    expect(FALLBACK_WORDS).toEqual({ C: ['nostalgia', 'gregarious', 'lucid'], H: ['trunk', 'rack', 'pawn'] });\n    expect(ALL_ACCEPTANCE_WORDS).toHaveLength(36);",
        "    // H has many stand-ins: a run of H that could not be judged (Free Dictionary down) still leaves an entry for every H word it used\n    expect(FALLBACK_WORDS).toEqual({ C: ['nostalgia', 'gregarious', 'lucid'], H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam'] });\n    expect(ALL_ACCEPTANCE_WORDS).toHaveLength(43);\n    expect(new Set(ALL_ACCEPTANCE_WORDS).size).toBe(43); // no word twice, in a group or between a group and a stand-in",
      ],
      [
        "  it('only the selected groups, in canonical order', () => {\n    expect(planWords(['H', 'A'], allOk).run.map((w) => w.group)).toEqual(['A', 'A', 'A', 'H', 'H', 'H', 'H', 'H', 'H']);\n  });",
        "  it('only the selected groups, in canonical order', () => {\n    expect(planWords(['H', 'A'], allOk).run.map((w) => w.group)).toEqual(['A', 'A', 'A', 'H', 'H', 'H', 'H', 'H', 'H']);\n  });\n\n  it('RUNS group H before E and F (the two groups that make Free Dictionary hang), whatever order --only lists them in', () => {\n    expect(RUN_ORDER).toEqual(['A', 'B', 'C', 'D', 'H', 'E', 'F']);\n    expect([...RUN_ORDER].sort()).toEqual([...GROUP_ORDER].sort()); // the same seven groups, only the order differs\n    const order = (groups: readonly Group[]) => [...new Set(planWords(groups, allOk).run.map((w) => w.group))];\n    expect(order(GROUP_ORDER)).toEqual(['A', 'B', 'C', 'D', 'H', 'E', 'F']);\n    expect(order(['F', 'E', 'H'])).toEqual(['H', 'E', 'F']);\n    expect(GROUP_ORDER).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'H']); // the order of the brief and of the tables is not touched\n  });\n\n  it('a second run of H finds fresh words after the first one used up its own (their entries now exist)', () => {\n    const used = new Set(['batter', 'mole', 'sage', 'tick', 'bass', 'fawn', 'trunk', 'rack']);\n    const p = planWords(['H'], (_g, w) => (used.has(w) ? { ok: false, reason: 'đã có mục từ' } : { ok: true, reason: 'ok' }));\n    expect(p.run.map((w) => w.word)).toEqual(['pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt']);\n    expect(p.run.filter((w) => w.standsInFor).length).toBe(6);\n  });",
      ],
    ],
  },
];
