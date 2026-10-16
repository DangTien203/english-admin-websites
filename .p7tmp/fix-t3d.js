const fs = require('fs');
const f = 'scripts/acceptance/lookup-acceptance.ts';
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
if (crlf) s = s.split('\r\n').join('\n');
const DOLLAR = String.fromCharCode(36);
const token = DOLLAR + '{UNEVALUABLE_LABEL}';
let n = 0;
s = s.split('\n').map((line) => {
  if (!line.startsWith("  lines.push('") || !line.includes(token)) return line;
  n++;
  return line.split(token).join("' + UNEVALUABLE_LABEL + '");
}).join('\n');
if (crlf) s = s.split('\n').join('\r\n');
fs.writeFileSync(f, s);
console.log('fixed lines:', n);
