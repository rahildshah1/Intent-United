    (function () {
      var form = document.getElementById('auth-form');
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.auth-tab'));
      var tabIndicator = document.querySelector('.auth-tab-indicator');
      var nameField = document.getElementById('name-field');
      var nameInput = nameField.querySelector('input');
      var pwInput = document.getElementById('password');
      var pwChecklist = document.getElementById('pw-checklist');
      var loginExtras = document.getElementById('login-extras');
      var submitBtn = document.getElementById('auth-submit');
      var title = document.getElementById('auth-title');
      var subtitle = document.getElementById('auth-subtitle');
      var switchLine = document.getElementById('auth-switch');
      var errorBox = document.getElementById('auth-error');
      var noticeBox = document.getElementById('auth-notice');
      var toggleBtn = document.getElementById('toggle-pw');
      var authBody = document.getElementById('auth-body');

      var mode = 'login';

      function showError(msg) {
        errorBox.textContent = msg;
        errorBox.hidden = false;
      }
      function clearError() {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
      function showNotice(msg) {
        noticeBox.textContent = msg;
        noticeBox.hidden = false;
      }
      function clearNotice() {
        noticeBox.hidden = true;
        noticeBox.textContent = '';
      }

      function moveTabIndicator() {
        var active = tabs.filter(function (t) { return t.dataset.mode === mode; })[0];
        if (!active || !tabIndicator) return;
        tabIndicator.style.width = active.offsetWidth + 'px';
        tabIndicator.style.translate = active.offsetLeft + 'px 0';
      }

      // A little squash-and-release on the sliding pill so the toggle feels tactile.
      function bounceTabIndicator() {
        if (!tabIndicator) return;
        tabIndicator.classList.add('is-squashing');
        tabIndicator.style.scale = '0.82 1.16';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            tabIndicator.classList.remove('is-squashing');
            tabIndicator.style.scale = '1 1';
          });
        });
      }

      var pwRules = {
        length: function (v) { return v.length >= 8; },
        upper: function (v) { return /[A-Z]/.test(v); },
        lower: function (v) { return /[a-z]/.test(v); },
        number: function (v) { return /[0-9]/.test(v); },
        symbol: function (v) { return /[^A-Za-z0-9]/.test(v); }
      };
      var pwCheckEls = Array.prototype.slice.call(document.querySelectorAll('.pw-check'));

      function updatePwChecklist() {
        var value = pwInput.value;
        pwCheckEls.forEach(function (el) {
          var rule = pwRules[el.dataset.rule];
          var met = !!(rule && rule(value));
          el.classList.toggle('is-met', met);
          // Only flag a rule as failed once the user has typed something —
          // an empty field should look neutral, not like five failures.
          el.classList.toggle('is-unmet', !met && value.length > 0);
        });
      }

      function pwFailedRules(value) {
        return Object.keys(pwRules).filter(function (key) { return !pwRules[key](value); });
      }

      function updateTabsUI() {
        tabs.forEach(function (t) {
          t.classList.toggle('is-active', t.dataset.mode === mode);
        });
        moveTabIndicator();
      }

      function submitLabel() {
        return mode === 'signup' ? 'Create Account' : 'Log In';
      }

      function applyModeContent() {
        clearError();
        clearNotice();

        var signup = mode === 'signup';

        nameField.hidden = !signup;
        nameInput.required = signup;
        pwChecklist.hidden = !signup;
        loginExtras.hidden = signup;
        pwInput.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');

        title.textContent = signup ? 'Create your account' : 'Welcome back';
        subtitle.textContent = signup
          ? 'Join Intent United in just a few seconds.'
          : 'Enter your details to access your account.';
        submitBtn.textContent = submitLabel();
        switchLine.innerHTML = signup
          ? 'Already have an account? <a href="#" data-mode="login">Log in</a>'
          : "Don't have an account? <a href=\"#\" data-mode=\"signup\">Sign up</a>";
      }

      // Reserve enough height for the taller (signup) form in both modes so
      // toggling never resizes the card — that resize was what made the whole
      // page appear to jump up and down, since the section re-centers on it.
      function lockAuthBodyHeight() {
        if (!authBody) return;
        var originalMode = mode;

        authBody.style.minHeight = '';
        mode = 'login';
        applyModeContent();
        var loginHeight = authBody.offsetHeight;

        mode = 'signup';
        applyModeContent();
        var signupHeight = authBody.offsetHeight;

        mode = originalMode;
        applyModeContent();
        authBody.style.minHeight = Math.max(loginHeight, signupHeight) + 'px';
      }

      function setMode(next) {
        mode = next;
        updateTabsUI();
        applyModeContent();
      }

      var FADE_MS = 180;

      function switchMode(next) {
        if (next === mode) return;
        bounceTabIndicator();
        mode = next;
        updateTabsUI();

        var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!authBody || reduceMotion) {
          applyModeContent();
          return;
        }

        authBody.classList.add('is-switching');
        window.setTimeout(function () {
          applyModeContent();
          requestAnimationFrame(function () {
            authBody.classList.remove('is-switching');
          });
        }, FADE_MS);
      }

      tabs.forEach(function (t) {
        t.addEventListener('click', function () { switchMode(t.dataset.mode); });
      });

      switchLine.addEventListener('click', function (e) {
        var link = e.target.closest('a[data-mode]');
        if (!link) return;
        e.preventDefault();
        switchMode(link.dataset.mode);
      });

      if (pwInput) {
        pwInput.addEventListener('input', updatePwChecklist);
      }

      var resizeTimer = null;
      window.addEventListener('resize', function () {
        moveTabIndicator();
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(lockAuthBodyHeight, 150);
      });

      if (toggleBtn && pwInput) {
        toggleBtn.addEventListener('click', function () {
          var hidden = pwInput.type === 'password';
          pwInput.type = hidden ? 'text' : 'password';
          toggleBtn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
          toggleBtn.classList.toggle('is-visible', hidden);
        });
      }

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearError();
        clearNotice();

        if (!window.IntentAuth) {
          showError('Auth is not configured yet. Check that config.js is present.');
          return;
        }

        var data = new FormData(form);
        var email = data.get('email');
        var password = data.get('password');

        if (mode === 'signup' && pwFailedRules(password).length) {
          updatePwChecklist();
          showError("Your password doesn't meet the requirements below.");
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';

        try {
          if (mode === 'signup') {
            await IntentAuth.register(data.get('name'), email, password);
          } else {
            await IntentAuth.login(email, password);
          }
          window.location.href = 'ai.html';
        } catch (err) {
          if (err && err.code === 'weak_password') {
            showError("Your password doesn't meet the requirements below.");
          } else {
            showError(IntentAuth.describeAuthError(err));
          }
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = submitLabel();
        }
      });

      // The card can start hidden (the AI page only reveals it once it knows
      // nobody is signed in), so measuring has to be re-runnable.
      window.IntentAuthForm = {
        refresh: function () { moveTabIndicator(); lockAuthBodyHeight(); }
      };

      setMode('login');
      lockAuthBodyHeight();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(lockAuthBodyHeight);
      }

      // Surfaced when the session was ended automatically for inactivity, or
      // after the account was deleted from the account page.
      var params = new URLSearchParams(window.location.search);
      if (params.get('timeout') === '1') {
        showNotice('You were signed out after a period of inactivity. Please log in again.');
        history.replaceState(null, '', window.location.pathname);
      } else if (params.get('deleted') === '1') {
        showNotice('Your account and all of its data have been permanently deleted.');
        history.replaceState(null, '', window.location.pathname);
      }
    })();
