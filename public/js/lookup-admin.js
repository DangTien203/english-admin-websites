// Lookup / enrichment admin pages (views/lookup/*). Plain browser JavaScript, no libraries.
// The pages are rendered by the server; this file only calls the JSON endpoints under /lookup/api and updates the page.
// Text from the server is always put in with textContent, never as HTML (except the entry detail, which the server rendered
// and escaped itself).
(function () {
  'use strict';

  var NOTICE_KEY = 'lk-notice';
  var API = '/lookup/api';

  var ADD_STATUS = {
    queued: 'Đã thêm vào hàng đợi',
    already_queued: 'Đã có trong hàng đợi',
    skipped: 'Bỏ qua',
    disabled: 'Làm giàu đang tắt',
    error: 'Lỗi'
  };
  var REASONS = {
    exists: 'Đã có mục từ trong từ điển',
    invalid_word: 'Từ không hợp lệ',
    daily_cap: 'Đã hết trần job trong ngày',
    duplicate: 'Đã có job cho từ này',
    queue_error: 'Lỗi hàng đợi, xem log máy chủ',
    not_attempted: 'Chưa thử vì hàng đợi đang lỗi'
  };
  var SKIP = {
    not_found: 'không tìm thấy',
    not_auto: 'không phải mục từ tự tạo',
    already_published: 'đã xuất bản',
    tier_a_incomplete: 'thiếu trường bắt buộc (tầng A)',
    has_review_notes: 'có ghi chú cần xem của Haiku'
  };

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  function request(method, url, body) {
    var options = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        return { status: res.status, ok: res.ok && !!json && json.success === true, json: json };
      });
    });
  }

  function errorText(r) {
    if (r.status === 401) return 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.';
    if (r.status === 403) return 'Bạn không có quyền thực hiện thao tác này.';
    if (r.json && r.json.error && r.json.error.message) return r.json.error.message;
    return 'Có lỗi xảy ra (HTTP ' + r.status + ').';
  }

  function showNotice(type, text) {
    var el = $('#lk-notice');
    if (!el) return;
    // created here (not in the template) because main.js removes every .alert that exists when the page has loaded
    el.textContent = '';
    var box = document.createElement('div');
    box.className = 'alert alert-' + type;
    box.textContent = text;
    el.appendChild(box);
    el.scrollIntoView({ block: 'nearest' });
  }

  function reloadWithNotice(type, text) {
    try { sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ type: type, text: text })); } catch (e) { /* private mode: no message */ }
    window.location.reload();
  }

  function showPendingNotice() {
    var raw;
    try { raw = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var n = JSON.parse(raw);
      showNotice(n.type, n.text);
    } catch (e) { /* ignore */ }
  }

  // ── send words to the queue ──
  function wordsOf(text) {
    return text.split(/\r?\n/).map(function (w) { return w.trim(); }).filter(function (w) { return w.length > 0; });
  }

  function renderAddResult(data) {
    var box = $('#lk-add-result');
    var rows = $('#lk-add-rows');
    var summary = $('#lk-add-summary');
    if (!box || !rows || !summary) return;
    rows.textContent = '';
    data.results.forEach(function (r) {
      var tr = document.createElement('tr');
      [r.word, ADD_STATUS[r.status] || r.status, r.reason ? (REASONS[r.reason] || r.reason) : ''].forEach(function (text, i) {
        var td = document.createElement('td');
        td.textContent = text;
        if (i === 0) td.style.fontWeight = '600';
        tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
    var s = data.summary;
    summary.textContent = 'Đã thêm ' + s.queued + ' · đã có trong hàng đợi ' + s.already_queued + ' · bỏ qua ' + s.skipped +
      (s.disabled ? ' · làm giàu đang tắt ' + s.disabled : '') + (s.error ? ' · lỗi ' + s.error : '') +
      (s.requested !== s.processed ? ' (' + (s.requested - s.processed) + ' dòng trùng đã gộp)' : '') + '.';
    box.style.display = 'block';
  }

  function initAddWords() {
    var form = $('#lk-add-words');
    if (!form) return;
    var area = $('#lk-words');
    var counter = $('#lk-word-count');
    var max = parseInt(form.getAttribute('data-max'), 10) || 50;

    function update() {
      var n = wordsOf(area.value).length;
      counter.textContent = n + ' / ' + max + ' từ';
      counter.style.color = n > max ? 'var(--danger)' : '';
    }
    area.addEventListener('input', update);
    update();

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var words = wordsOf(area.value);
      if (words.length === 0) { showNotice('warning', 'Hãy nhập ít nhất một từ.'); return; }
      if (words.length > max) { showNotice('error', 'Tối đa ' + max + ' từ mỗi lần (đang có ' + words.length + ').'); return; }
      var button = $('button[type=submit]', form);
      button.disabled = true;
      request('POST', API + '/jobs', { words: words }).then(function (r) {
        button.disabled = false;
        if (!r.ok) { showNotice('error', errorText(r)); return; }
        renderAddResult(r.json.data);
        var s = r.json.data.summary;
        showNotice(s.queued > 0 ? 'success' : 'warning', s.queued > 0 ? 'Đã thêm ' + s.queued + ' từ vào hàng đợi. Tải lại trang để thấy job mới.' : 'Không có từ nào được thêm, xem bảng kết quả.');
      }).catch(function () { button.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
    });
  }

  // ── retry one job ──
  function initRetry() {
    $all('[data-lk-retry]').forEach(function (button) {
      button.addEventListener('click', function () {
        var word = button.getAttribute('data-word');
        button.disabled = true;
        request('POST', API + '/jobs/' + encodeURIComponent(button.getAttribute('data-lk-retry')) + '/retry', {}).then(function (r) {
          if (!r.ok) { button.disabled = false; showNotice('error', errorText(r)); return; }
          var result = r.json.data.result;
          if (result.status === 'queued') { reloadWithNotice('success', 'Đã gửi lại “' + word + '” vào hàng đợi.'); return; }
          button.disabled = false;
          showNotice('warning', 'Không gửi lại được “' + word + '”: ' + (REASONS[result.reason] || result.reason || result.status) + '.');
        }).catch(function () { button.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
      });
    });
  }

  // ── missing words → queue ──
  function initAddOneWord() {
    $all('[data-lk-add-word]').forEach(function (button) {
      button.addEventListener('click', function () {
        var word = button.getAttribute('data-lk-add-word');
        button.disabled = true;
        request('POST', API + '/jobs', { words: [word] }).then(function (r) {
          if (!r.ok) { button.disabled = false; showNotice('error', errorText(r)); return; }
          var res = r.json.data.results[0];
          if (res.status === 'queued' || res.status === 'already_queued') {
            button.textContent = res.status === 'queued' ? 'Đã thêm' : 'Đã có trong hàng đợi';
            showNotice('success', '“' + word + '”: ' + ADD_STATUS[res.status] + '.');
            return;
          }
          button.disabled = false;
          showNotice('warning', '“' + word + '”: ' + (ADD_STATUS[res.status] || res.status) + (res.reason ? ' (' + (REASONS[res.reason] || res.reason) + ')' : '') + '.');
        }).catch(function () { button.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
      });
    });
  }

  // ── review of the entries made by the job ──
  function initReview() {
    var pane = $('#lk-detail-pane');
    var rows = $('#lk-entry-rows');
    if (!pane || !rows) return;

    function select(id) {
      $all('.lk-list-item', rows).forEach(function (tr) {
        tr.classList.toggle('selected', tr.getAttribute('data-lk-entry') === id);
      });
      pane.textContent = 'Đang tải...';
      fetch('/lookup/review/' + encodeURIComponent(id) + '/detail', { credentials: 'same-origin', headers: { Accept: 'text/html' } })
        .then(function (res) { return res.text().then(function (html) { return { ok: res.ok, html: html }; }); })
        .then(function (r) {
          pane.innerHTML = r.html; // rendered and escaped by the server (views/lookup/entry-detail.ejs)
          if (r.ok) {
            var url = new URL(window.location.href);
            url.searchParams.set('entry', id);
            window.history.replaceState(null, '', url.toString());
          }
        })
        .catch(function () { pane.textContent = 'Không tải được chi tiết.'; });
    }

    rows.addEventListener('click', function (event) {
      var target = event.target;
      if (target.closest('input, a, button, label')) return;
      var tr = target.closest('.lk-list-item');
      if (tr) select(tr.getAttribute('data-lk-entry'));
    });

    // publish / hide one entry (buttons live inside the detail, which is replaced on every selection)
    pane.addEventListener('click', function (event) {
      var publish = event.target.closest('[data-lk-publish]');
      var hide = event.target.closest('[data-lk-hide]');
      var button = publish || hide;
      if (!button) return;
      var detail = button.closest('.lk-detail');
      var headword = detail.getAttribute('data-headword');
      var missing = detail.getAttribute('data-tier-a-missing');
      var id = button.getAttribute(publish ? 'data-lk-publish' : 'data-lk-hide');

      if (publish && missing && !window.confirm('Mục từ “' + headword + '” còn thiếu: ' + missing + '.\nỨng dụng có thể hiển thị thiếu. Vẫn xuất bản?')) return;
      if (hide && !window.confirm('Ẩn mục từ “' + headword + '”? Người dùng sẽ không thấy nó trong từ điển nữa.')) return;

      button.disabled = true;
      request('POST', API + '/auto-entries/' + encodeURIComponent(id) + (publish ? '/publish' : '/hide'), {}).then(function (r) {
        if (!r.ok) { button.disabled = false; showNotice('error', errorText(r)); return; }
        reloadWithNotice('success', publish ? 'Đã xuất bản “' + headword + '”.' : 'Đã ẩn “' + headword + '”.');
      }).catch(function () { button.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
    });

    // edit the Vietnamese of one sense in place (the form is in the detail, which is replaced on every selection)
    pane.addEventListener('click', function (event) {
      var open = event.target.closest('[data-lk-edit-sense]');
      var cancel = event.target.closest('[data-lk-cancel-sense]');
      if (!open && !cancel) return;
      var senseId = (open || cancel).getAttribute(open ? 'data-lk-edit-sense' : 'data-lk-cancel-sense');
      var sense = event.target.closest('.lk-sense');
      var form = $('[data-lk-sense-form="' + senseId + '"]', sense);
      var button = $('[data-lk-edit-sense="' + senseId + '"]', sense);
      if (!form || !button) return;
      form.hidden = !open;
      button.hidden = !!open;
      if (open) { var area = $('textarea', form); if (area) area.focus(); }
    });

    pane.addEventListener('submit', function (event) {
      var form = event.target.closest('[data-lk-sense-form]');
      if (!form) return;
      event.preventDefault();
      var entryId = form.getAttribute('data-entry-id');
      var senseId = form.getAttribute('data-lk-sense-form');
      var body = {
        definition_vi: $('textarea[name=definition_vi]', form).value,
        examples: $all('input[name=example_vi]', form).map(function (input) {
          return { id: input.getAttribute('data-example-id'), example_vi: input.value };
        })
      };
      if (body.examples.length === 0) delete body.examples;
      var submit = $('button[type=submit]', form);
      submit.disabled = true;
      request('PATCH', API + '/auto-entries/' + encodeURIComponent(entryId) + '/senses/' + encodeURIComponent(senseId), body).then(function (r) {
        submit.disabled = false;
        if (!r.ok) { showNotice('error', errorText(r)); return; }
        if (r.json.data.changed) {
          select(entryId); // draw the stored text, with its flags, and the new line of the history
          showNotice('success', 'Đã lưu nghĩa tiếng Việt của sense.');
        } else {
          showNotice('warning', 'Nội dung không thay đổi nên chưa ghi gì.');
        }
      }).catch(function () { submit.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
    });

    initBulk(rows);
  }

  // The confirmation box of a bulk publish: how many entries, and 5 of them picked at random (public/js/lookup-bulk-confirm.js).
  // Resolves true when the admin confirms. A browser without <dialog> gets a plain confirm() with the same facts.
  function confirmBulk(chosen) {
    var d = window.LookupBulk.describeSelection(chosen);
    var dialog = $('#lk-bulk-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(d.plain));

    $('#lk-bulk-title').textContent = d.title;
    $('#lk-bulk-lead').textContent = d.lead;
    $('#lk-bulk-more').textContent = d.more;
    var list = $('#lk-bulk-sample');
    list.textContent = '';
    d.sample.forEach(function (headword) {
      var li = document.createElement('li');
      li.textContent = headword;
      list.appendChild(li);
    });
    return new Promise(function (resolve) {
      dialog.addEventListener('close', function onClose() {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'confirm');
      });
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  function initBulk(rows) {
    var button = $('#lk-bulk-publish');
    var all = $('#lk-select-all');
    if (!button) return;
    var counter = $('#lk-selected-count');
    var max = parseInt(button.getAttribute('data-max'), 10) || 100;

    function boxes() { return $all('.lk-select', rows); }
    function selected() { return boxes().filter(function (b) { return b.checked; }); }
    function update() {
      var n = selected().length;
      counter.textContent = n;
      button.disabled = n === 0 || n > max;
      if (all) all.checked = boxes().length > 0 && n === boxes().length;
    }

    rows.addEventListener('change', function (event) { if (event.target.classList.contains('lk-select')) update(); });
    if (all) all.addEventListener('change', function () { boxes().forEach(function (b) { b.checked = all.checked; }); update(); });
    update();

    button.addEventListener('click', function () {
      var chosen = selected().map(function (b) { return { id: b.value, headword: b.getAttribute('data-headword') || b.value }; });
      if (chosen.length === 0) return;
      confirmBulk(chosen).then(function (yes) {
        if (yes) publishAll(chosen.map(function (c) { return c.id; }));
      });
    });

    function publishAll(ids) {
      button.disabled = true;
      request('POST', API + '/auto-entries/bulk-publish', { entry_ids: ids }).then(function (r) {
        if (!r.ok) { button.disabled = false; showNotice('error', errorText(r)); return; }
        var d = r.json.data;
        var text = 'Đã xuất bản ' + d.published.length + ' mục từ.';
        if (d.skipped.length > 0) {
          text += ' Bỏ qua ' + d.skipped.length + ': ' + d.skipped.map(function (s) {
            return (s.headword || s.id) + ' (' + (SKIP[s.reason] || s.reason) + ')';
          }).join('; ') + '.';
        }
        reloadWithNotice(d.skipped.length > 0 ? 'warning' : 'success', text);
      }).catch(function () { button.disabled = false; showNotice('error', 'Không kết nối được máy chủ.'); });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    showPendingNotice();
    initAddWords();
    initRetry();
    initAddOneWord();
    initReview();
  });
})();
