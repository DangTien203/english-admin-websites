// CRLF-aware exact-string patcher: node .p7tmp/patch.js <spec.js>
// spec.js exports { file: 'path', edits: [[old, new], ...] } (use String.raw / plain strings, LF newlines).
const fs = require('fs');
const path = require('path');
const spec = require(path.resolve(process.argv[2]));
const specs = Array.isArray(spec) ? spec : [spec];
for (const s of specs) {
  let text = fs.readFileSync(s.file, 'utf8');
  const crlf = text.includes('\r\n');
  if (crlf) text = text.split('\r\n').join('\n');
  for (const [from, to] of s.edits) {
    const first = text.indexOf(from);
    if (first < 0) throw new Error(`${s.file}: text not found: ${from.slice(0, 80)}`);
    if (text.indexOf(from, first + 1) >= 0) throw new Error(`${s.file}: text found more than once: ${from.slice(0, 80)}`);
    text = text.slice(0, first) + to + text.slice(first + from.length);
  }
  if (crlf) text = text.split('\n').join('\r\n');
  fs.writeFileSync(s.file, text);
  console.log(`patched ${s.file} (${crlf ? 'CRLF' : 'LF'}, ${s.edits.length} edit${s.edits.length === 1 ? '' : 's'})`);
}
