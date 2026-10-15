const bs = String.fromCharCode(92);
// the six characters: backslash u 0 0 3 c   (the JSON escape of "<")
const lt = bs + 'u003c';
const zw = bs + 'u200b-' + bs + 'u200f' + bs + 'u2028' + bs + 'u2029' + bs + 'ufeff';
const zwShort = bs + 'u200b-' + bs + 'u200f' + bs + 'ufeff';

const oldLine = "  return jsonText.replace(/<(" + bs + "/?)(data)/gi, '" + bs + lt + "$1$2');";
const newLine =
  '  // "<data", "</data", and the forms a model might still read as a tag: whitespace or zero-width characters between "<", "/" and "data".\n' +
  '  return jsonText.replace(/<([' + bs + 's' + zw + ']*' + bs + '/?[' + bs + 's' + zwShort + ']*)(data)/gi, \'' + bs + lt + "$1$2');";

module.exports = [{ file: 'services/enrichment/haiku/user-message.ts', edits: [[oldLine, newLine]] }];
