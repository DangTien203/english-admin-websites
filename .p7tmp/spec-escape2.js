const bs = String.fromCharCode(92);
const cls = bs + 's' + bs + 'u200b-' + bs + 'u200f' + bs + 'u2028' + bs + 'u2029' + bs + 'ufeff/';
const before = "/<([" + bs + 's' + bs + 'u200b-' + bs + 'u200f' + bs + 'u2028' + bs + 'u2029' + bs + 'ufeff]*' + bs + '/?[' + bs + 's' + bs + 'u200b-' + bs + 'u200f' + bs + 'ufeff]*)(data)/gi';
const after = '/<([' + cls + ']*)(data)/gi';
module.exports = [{
  file: 'services/enrichment/haiku/user-message.ts',
  edits: [
    [before, after],
    ['  // "<data", "</data", and the forms a model might still read as a tag: whitespace or zero-width characters between "<", "/" and "data".',
     '  // "<data", "</data", and the forms a model might still read as a tag: whitespace, slashes or zero-width characters between "<" and\n  // "data". ONE character class (no two adjacent quantifiers), so a long run after a "<" costs linear time.'],
  ],
}];
