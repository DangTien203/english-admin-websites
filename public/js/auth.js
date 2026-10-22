// Sign-in and sign-up pages: show/hide password, Caps Lock warning, password strength, confirm check, double-submit guard.
(function () {
  'use strict';

  // ── Show / hide password ──
  document.querySelectorAll('[data-toggle-password]').forEach(function (button) {
    var input = document.getElementById(button.getAttribute('data-toggle-password'));
    if (!input) return;
    button.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      button.classList.toggle('is-visible', show);
      input.focus();
    });
  });

  // ── Caps Lock warning ──
  document.querySelectorAll('[data-caps-lock]').forEach(function (input) {
    var hint = document.getElementById(input.getAttribute('data-caps-lock'));
    if (!hint) return;
    var update = function (event) {
      if (typeof event.getModifierState !== 'function') return;
      hint.hidden = !event.getModifierState('CapsLock');
    };
    input.addEventListener('keydown', update);
    input.addEventListener('keyup', update);
    input.addEventListener('blur', function () { hint.hidden = true; });
  });

  // ── Password strength (visual only: the server enforces the real rule) ──
  var LEVELS = ['Rất yếu', 'Yếu', 'Khá', 'Tốt', 'Mạnh'];
  function score(value) {
    if (!value) return 0;
    var points = 0;
    if (value.length >= 6) points++;
    if (value.length >= 10) points++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points++;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) points++;
    else if (/\d/.test(value) || /[^A-Za-z0-9]/.test(value)) points += 0.5;
    return Math.min(4, Math.floor(points));
  }
  document.querySelectorAll('[data-strength-input]').forEach(function (input) {
    var meter = input.closest('.field').querySelector('[data-strength]');
    if (!meter) return;
    var bars = meter.querySelectorAll('.strength-bars span');
    var label = meter.querySelector('.strength-label');
    input.addEventListener('input', function () {
      var level = score(input.value);
      meter.hidden = input.value.length === 0;
      meter.setAttribute('data-level', String(level));
      bars.forEach(function (bar, index) { bar.classList.toggle('on', index < Math.max(level, input.value ? 1 : 0)); });
      label.textContent = LEVELS[level];
    });
  });

  // ── Confirm password ──
  document.querySelectorAll('[data-confirm-of]').forEach(function (input) {
    var original = document.getElementById(input.getAttribute('data-confirm-of'));
    var hint = input.closest('.field').querySelector('[data-confirm-hint]');
    if (!original) return;
    var check = function () {
      var mismatch = input.value.length > 0 && input.value !== original.value;
      input.setCustomValidity(mismatch ? 'Mật khẩu xác nhận chưa khớp.' : '');
      input.classList.toggle('is-invalid', mismatch);
      if (hint) hint.hidden = !mismatch;
    };
    input.addEventListener('input', check);
    original.addEventListener('input', check);
  });

  // ── Submit: tidy the e-mail, and refuse a second click while the first request is on its way ──
  document.querySelectorAll('[data-auth-form]').forEach(function (form) {
    var button = form.querySelector('.auth-submit');
    form.addEventListener('submit', function (event) {
      if (form.getAttribute('data-submitting') === 'true') {
        event.preventDefault();
        return;
      }
      form.querySelectorAll('[data-normalize-email]').forEach(function (email) {
        email.value = email.value.trim().toLowerCase();
      });
      form.setAttribute('data-submitting', 'true');
      if (button) {
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
      }
    });
    // Coming back with the browser's Back button must not show a stuck spinner.
    window.addEventListener('pageshow', function () {
      form.removeAttribute('data-submitting');
      if (button) {
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
      }
    });
  });
})();
