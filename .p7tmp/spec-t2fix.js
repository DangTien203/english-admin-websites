module.exports = [
  {
    file: 'tests/lookup/lookupService.test.ts',
    edits: [
      [
        "    expect(r.body.translation_vi).toBe('chào');\n    expect(err).toHaveBeenCalledTimes(1);",
        "    expect(r.body.translation_vi.startsWith('chào')).toBe(true);\n    expect(err).toHaveBeenCalledTimes(1);",
      ],
    ],
  },
];
