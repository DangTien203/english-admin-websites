const fs = require('fs');
let body = fs.readFileSync('.p7tmp/report-body.ts', 'utf8');
body = body.replace("  breakerResetMs: number;", "  breakerResetMs: number;\n  /** the settings the server and this script share, printed in the header of the report */\n  settings: { publishPolicy: string; totalDeadlineMs: number; fastTranslator: string };");
const header = `/**
 * The acceptance report (docs/lookup-acceptance-report.md), written in Vietnamese. Pure: a RunSummary in, Markdown out, so the
 * wording of every kind of row (pass, fail, "cannot be judged", skipped) is tested without running the 30 words
 * (tests/acceptance/report.test.ts).
 */
import { dbLabel, utcMonth, type DatabaseIdentity } from './db';
import { UNEVALUABLE_LABEL, type FastObservation, type FastSummary, type JobObservation, type LatencyResult, type Verdict } from './evaluate';
import { describeProbe, type ProbeResult } from './source';
import { jobExpectation, type Group, type PlannedWord, type SkippedWord } from './words';
import { PRICING_CHECKED_ON } from '../../services/enrichment/pricing';

`;
fs.writeFileSync('scripts/acceptance/report.ts', header + body);

// the script passes the settings
const f = 'scripts/acceptance/lookup-acceptance.ts';
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
if (crlf) s = s.split('\r\n').join('\n');
const needle = "    breakerResetMs: lookupConfig.breaker.resetMs,\n    rerun,\n  };";
if (!s.includes(needle)) throw new Error('summary literal not found');
s = s.replace(needle, "    breakerResetMs: lookupConfig.breaker.resetMs,\n    settings: { publishPolicy: lookupConfig.flags.enrichmentPublishPolicy, totalDeadlineMs: lookupConfig.lookup.totalDeadlineMs, fastTranslator: lookupConfig.lookup.fastTranslator },\n    rerun,\n  };");
if (crlf) s = s.split('\n').join('\r\n');
fs.writeFileSync(f, s);
console.log('ok');
