const fs = require('fs');
let s = fs.readFileSync('.p7tmp/spec-docs4.js', 'utf8');
const A = '### 2.5 Điều thấy thêm khi chạy, ngoài phạm vi tra từ';
const B = '## 3. EXPLAIN (ANALYZE, BUFFERS)';
let n = s.split(A).length - 1;
console.log('occurrences', n);
s = s.split(A).join(B);
fs.writeFileSync('.p7tmp/spec-docs4.js', s);
