module.exports = [
  {
    file: 'scripts/loadtest/lookup-burst.ts',
    edits: [
      [
        "const SEND = argv.includes('--skip-send') ? 0 : num('send', 30);",
        "const SEND = argv.includes('--skip-send') ? 0 : num('send', 30);\n/** Only scenario D (the others take minutes and are not affected by where the job send happens). */\nconst ONLY_SEND = argv.includes('--only-send');",
      ],
      [
        "    await scenarioBaseline(mock, ebookId, tokens);\n    if (!SKIP_SLOW) await scenarioSingleFlight(mock, ebookId, tokens);\n    if (SEND > 0) await scenarioJobSend(mock, ebookId, tokens);",
        "    if (!ONLY_SEND) await scenarioBaseline(mock, ebookId, tokens);\n    if (!ONLY_SEND && !SKIP_SLOW) await scenarioSingleFlight(mock, ebookId, tokens);\n    if (SEND > 0) await scenarioJobSend(mock, ebookId, tokens);",
      ],
      [
        " *   npm run loadtest:lookup -- --send 30         # words of scenario D (default 30; --skip-send leaves the scenario out)",
        " *   npm run loadtest:lookup -- --send 30         # words of scenario D (default 30; --skip-send leaves the scenario out)\n *   npm run loadtest:lookup -- --only-send       # only scenario D (about a minute)",
      ],
    ],
  },
];
