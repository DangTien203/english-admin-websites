const fs = require('fs');
let s = fs.readFileSync('.p7tmp/spec-t3c.js', 'utf8');
const a = "nên dòng được ghi là \"\${UNEVALUABLE_LABEL}\", không phải \"không đạt\".');";
const b = "từ H không có sense được ghi là \"\${UNEVALUABLE_LABEL}\". Phần job nền";
const i1 = s.indexOf(a), i2 = s.indexOf(b);
console.log(i1, i2);
s = s.replace(a, "nên dòng được ghi là \"' + UNEVALUABLE_LABEL + '\", không phải \"không đạt\".');");
s = s.replace(b, "từ H không có sense được ghi là \"' + UNEVALUABLE_LABEL + '\". Phần job nền");
fs.writeFileSync('.p7tmp/spec-t3c.js', s);
