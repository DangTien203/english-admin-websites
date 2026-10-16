module.exports = [
  { file: 'CLAUDE.md', edits: [[
    "npm run check:env-example  # .env.example must match config/lookup.ts (also runs first in `npm test`)",
    "npm run check:env-example  # .env.example must match config/lookup.ts, and every example value must equal the schema default (also runs first in `npm test`)",
  ], [
    "npm run acceptance:lookup -- --staging  # 30-word acceptance run against a running server on the dev DB (real network, spends tokens); report in docs/lookup-acceptance-report.md; --cleanup needs the DB name retyped — docs/lookup-runbook.md §12",
    "npm run acceptance:lookup -- --staging  # 30-word acceptance run against a running server on the dev DB (real network, spends tokens); report in docs/lookup-acceptance-report.md; probes Free Dictionary first (words it cannot judge are \"không đánh giá được\", exit code 3); --cleanup needs the DB name retyped — docs/lookup-runbook.md §12",
  ]] },
];
