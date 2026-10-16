const fs = require('fs');
const f = 'scripts/acceptance/lookup-acceptance.ts';
let text = fs.readFileSync(f, 'utf8');
const crlf = text.includes('\r\n');
if (crlf) text = text.split('\r\n').join('\n');
const lines = text.split('\n');
const idx = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; throw new Error('not found ' + re); };

const wrStart = idx(/^interface WordResult \{/);
let wrEnd = wrStart; while (lines[wrEnd] !== '}') wrEnd++;
const repStart = idx(/^\/\/ ── helpers for the report/);
const repEnd = idx(/^\/\/ ── the run ──/) - 1; // the blank line before "the run" stays

const wordResult = lines.slice(wrStart, wrEnd + 1);
const report = lines.slice(repStart, repEnd);   // helpers .. buildReport (ends with a blank line)

// remove from the script (report block first, it comes later in the file)
lines.splice(repStart, repEnd - repStart);
lines.splice(wrStart, wrEnd - wrStart + 2); // the interface and the blank line after it

let out = lines.join('\n');
// the script now imports what it needs from report.ts
out = out.replace("import { breakerLikelyOpen,", "import { buildReport, verdictLabel, fmtMs, type BreakerWait, type ProbeEntry, type RunSummary, type WordResult } from './report';\nimport { breakerLikelyOpen,");
if (crlf) out = out.split('\n').join('\r\n');
fs.writeFileSync(f, out);

let body = [...wordResult, '', ...report].join('\n');
body = body
  .replace(/^interface /gm, 'export interface ')
  .replace(/^const (fmtMs|cell|verdictLabel) /gm, 'export const $1 ')
  .replace(/^function buildReport/m, 'export function buildReport')
  .replace(/lookupConfig\.flags\.enrichmentPublishPolicy/g, 's.settings.publishPolicy')
  .replace(/lookupConfig\.lookup\.totalDeadlineMs/g, 's.settings.totalDeadlineMs')
  .replace(/lookupConfig\.lookup\.fastTranslator/g, 's.settings.fastTranslator');
fs.writeFileSync('.p7tmp/report-body.ts', body);
console.log('moved', wordResult.length, 'lines of WordResult and', report.length, 'lines of report');
