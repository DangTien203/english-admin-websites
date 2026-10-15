const fs = require('fs');
const file = 'tests/lookup/localLookup.test.ts';
let text = fs.readFileSync(file, 'utf8');
const crlf = text.includes('\r\n');
if (crlf) text = text.split('\r\n').join('\n');
const lines = text.split('\n');
const start = lines.findIndex((l) => l.includes('finds the candidates with a UNION'));
const end = lines.findIndex((l, i) => i > start && l === '  });');
const replacement = [
  "  it('finds the candidates with a UNION of three index lookups, not an OR (an OR cannot use the lower() indexes: 42-56 ms at 200k entries)', async () => {",
  '    const { db, calls } = fakeDb(() => []);',
  "    await lookupLocal(db, 'ran');",
  "    const flat = calls[0].sql.replace(/\\s+/g, ' ');",
  "    expect(flat).toContain('e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1 UNION SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1 UNION SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)');",
  "    expect(flat).not.toContain('= $1 OR');",
  "    expect(flat).not.toContain('OR e.id IN');",
  '  });',
];
lines.splice(start, end - start + 1, ...replacement);
text = lines.join('\n');
if (crlf) text = text.split('\n').join('\r\n');
fs.writeFileSync(file, text);
console.log('rewritten lines', start + 1, 'to', end + 1);
