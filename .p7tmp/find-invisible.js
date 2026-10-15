const fs = require('fs');
const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
const bad = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff, 0x202e]);
s.split('\n').forEach((line, i) => {
  const found = [...line].filter((ch) => bad.has(ch.codePointAt(0))).map((ch) => 'U+' + ch.codePointAt(0).toString(16));
  if (found.length) console.log(i + 1, found.join(','), JSON.stringify(line).slice(0, 100));
});
