// What the confirmation box of a bulk publish says (views/lookup/review.ejs, public/js/lookup-admin.js): how many entries are
// about to go public, and a few of them picked at random, so that the admin sees what is in the batch before saying yes.
//
// Plain functions with no page in them, so that tests (tests/admin/bulkConfirm.test.ts) load this file with require() and the
// browser loads it with a <script> tag (it then sets window.LookupBulk).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LookupBulk = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAMPLE_SIZE = 5;

  // Up to `n` DIFFERENT items of the list, in random order. The list itself is not changed. `random` is Math.random in the
  // browser; a test passes a fixed sequence.
  function pickSample(items, n, random) {
    var rnd = random || Math.random;
    var pool = items.slice();
    var want = Math.max(0, Math.min(n, pool.length));
    var out = [];
    for (var i = 0; i < want; i++) {
      var j = i + Math.floor(rnd() * (pool.length - i)); // partial Fisher-Yates
      if (j >= pool.length) j = pool.length - 1;
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      out.push(pool[i]);
    }
    return out;
  }

  // items: [{ id, headword }]. Returns the numbers and the sentences the box shows.
  function describeSelection(items, random) {
    var count = items.length;
    var sample = pickSample(items, SAMPLE_SIZE, random).map(function (item) { return item.headword; });
    var others = count - sample.length;
    return {
      count: count,
      sample: sample,
      others: others,
      title: 'Xuất bản hàng loạt',
      lead: 'Xuất bản ' + count + ' mục từ đã chọn? Dưới đây là ' + (others > 0 ? sample.length + ' mục lấy ngẫu nhiên:' : 'toàn bộ các mục:'),
      more: others > 0 ? 'và ' + others + ' mục khác.' : '',
      // for a browser without <dialog>: window.confirm() shows plain text only
      plain: 'Xuất bản ' + count + ' mục từ đã chọn?\n' + sample.join(', ') + (others > 0 ? ' và ' + others + ' mục khác' : '')
    };
  }

  return { SAMPLE_SIZE: SAMPLE_SIZE, pickSample: pickSample, describeSelection: describeSelection };
});
