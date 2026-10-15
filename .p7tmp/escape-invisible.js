// Rewrites literal invisible / bidi characters in a source file as \uXXXX escapes (valid in string, template and regex literals).
const fs = require('fs');
const file = process.argv[2];
const bad = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff, 0x202e, 0x202d, 0x202a, 0x202b, 0x202c]);
const s = fs.readFileSync(file, 'utf8');
let n = 0;
const out = [...s]
  .map((ch) => {
    const cp = ch.codePointAt(0);
    if (!bad.has(cp)) return ch;
    n++;
    return '\\u' + cp.toString(16).padStart(4, '0');
  })
  .join('');
fs.writeFileSync(file, out);
console.log(`${file}: ${n} invisible characters written as escapes`);
