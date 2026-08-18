/* ============================================================================
   Intent United — Biology Tutor (Gemini)

   The chat UI in the "Biology Lab" section of ai.html. This file never sees an
   API key: it posts the transcript to /api/bio-chat, and the Cloudflare Worker
   (worker/index.js) holds the keys, picks which key + model to spend, and
   counts the shared daily budget.

   Continuity mirrors the Botpress tutor above it: localStorage is the fast
   local cache, and public.bio_chats is the account's copy, so a conversation
   started on a classroom laptop reappears on a phone. Both are cleared on
   sign-out because devices here are often shared.
   ========================================================================== */

(function () {
  "use strict";

  var CACHE_KEY = "iu_bio_chat";
  var MAX_TURNS = 40;          // messages kept locally / synced (UI window)
  var SAVE_DEBOUNCE_MS = 1200;

  var STARTERS = [
    "Why do cells need mitochondria?",
    "Explain photosynthesis simply",
    "How does DNA decide my eye colour?",
    "What is natural selection?",
  ];

  var els = {};
  var messages = [];           // [{ role: "user" | "model", text }]
  var accountId = null;        // whose conversation this is
  var loading = true;          // composer is locked until restore() finishes
  var busy = false;            // a question is in flight
  var exhausted = false;       // every key and model is spent for the day
  var saveTimer = null;
  var syncEnabled = false;     // stays off until the account's copy is read

  /* ---- markdown-lite rendering -------------------------------------------
     The model is told to use only bold, bullets and small headings. We escape
     the whole string FIRST and only then add our own tags, so nothing the
     model emits can become live markup in the page. */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }

  function renderMarkdown(raw) {
    var lines = escapeHtml(raw).split(/\r?\n/);
    var html = "";
    var listOpen = false;

    function closeList() {
      if (listOpen) { html += "</ul>"; listOpen = false; }
    }

    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) { closeList(); return; }

      var bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        if (!listOpen) { html += "<ul>"; listOpen = true; }
        html += "<li>" + inline(bullet[1]) + "</li>";
        return;
      }

      var heading = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        closeList();
        html += "<h4>" + inline(heading[1]) + "</h4>";
        return;
      }

      closeList();
      html += "<p>" + inline(trimmed) + "</p>";
    });

    closeList();
    return html;
  }

  /* ---- rendering ---------------------------------------------------------- */

  function bubble(role, text) {
    var row = document.createElement("div");
    row.className = "bio-msg bio-msg-" + role;

    var body = document.createElement("div");
    body.className = "bio-bubble";
    if (role === "model") {
      body.innerHTML = renderMarkdown(text);
    } else {
      body.textContent = text;           // student text is never parsed
    }

    row.appendChild(body);
    return row;
  }

  function render() {
    els.log.innerHTML = "";

    if (!messages.length) {
      els.empty.hidden = false;
      els.log.appendChild(els.empty);
    } else {
      els.empty.hidden = true;
      messages.forEach(function (m) {
        els.log.appendChild(bubble(m.role, m.text));
      });
    }

    els.clear.hidden = !messages.length;
    scrollToEnd();
  }

  function scrollToEnd() {
    els.log.scrollTop = els.log.scrollHeight;
  }

  function showThinking() {
    var row = document.createElement("div");
    row.className = "bio-msg bio-msg-model bio-thinking";
    row.innerHTML =
      '<div class="bio-bubble"><span class="bio-dots">' +
      "<i></i><i></i><i></i></span></div>";
    els.log.appendChild(row);
    scrollToEnd();
    return row;
  }

  function setNotice(text, kind) {
    if (!text) {
      els.notice.hidden = true;
      els.notice.textContent = "";
      return;
    }
    els.notice.hidden = false;
    els.notice.textContent = text;
    els.notice.className = "bio-notice" + (kind ? " bio-notice-" + kind : "");
  }

  function setBusy(state) {
    busy = state;
    els.send.disabled = state || loading || exhausted;
    els.input.disabled = loading || exhausted;
    els.send.classList.toggle("is-busy", state);
    if (!loading && !exhausted) els.input.placeholder = "Ask a biology question…";
  }

  /* Lock the composer for the rest of the day once every key and model is
     spent. The budget resets on its own at midnight Pacific. */
  function lockOut(message) {
    exhausted = true;
    setNotice(message || "The AI Agent has run out of usage for the day. Please come back tomorrow.", "error");
    els.input.disabled = true;
    els.send.disabled = true;
    els.input.placeholder = "The tutor is resting until tomorrow.";
  }

  /* ---- persistence -------------------------------------------------------- */

  /* The cache is stamped with the account that wrote it. Devices here are
     often shared — a partner centre laptop, a classroom machine — and a
     browser that was closed rather than signed out keeps its localStorage. An
     unstamped cache would then be adopted by whoever signs in next, handing
     them the previous child's conversation. Stamping means a cache belonging
     to someone else is simply ignored. */

  function readCache(userId) {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || parsed.userId !== userId || !Array.isArray(parsed.messages)) return null;
      return parsed.messages;
    } catch (e) {
      return null;
    }
  }

  function writeCache() {
    if (!accountId) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: accountId, messages: messages }));
    } catch (e) { /* storage full or blocked — the account copy still holds */ }
  }

  /* Save locally at once, push to the account on a debounce — a reply is often
     followed straight away by the next question, and one upsert per exchange
     is plenty. */
  function persist() {
    if (messages.length > MAX_TURNS) messages = messages.slice(-MAX_TURNS);
    writeCache();
    if (!syncEnabled || !window.IntentAuth || !IntentAuth.saveBioChat) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      IntentAuth.saveBioChat(messages).catch(function () { /* local copy stands */ });
    }, SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (!syncEnabled || !window.IntentAuth || !IntentAuth.saveBioChat) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    IntentAuth.saveBioChat(messages).catch(function () { /* best effort */ });
  }

  /* Load this account's conversation. The composer stays disabled until this
     finishes, so a fast first question can't be overwritten by a restore that
     lands a moment later. */
  async function restore() {
    try {
      if (!window.IntentAuth || !IntentAuth.getUser) throw new Error("auth unavailable");

      var user = await IntentAuth.getUser();
      if (!user) throw new Error("signed-out");
      accountId = user.id;

      // Paint the account's own cache first so the panel fills instantly.
      var cached = readCache(accountId);
      if (cached && cached.length) { messages = cached; render(); }

      /* Then reconcile with the account's copy, which is authoritative — it is
         what carries the conversation across devices. */
      var saved = await IntentAuth.getBioChat();
      if (Array.isArray(saved)) {
        messages = saved;
      } else if (!cached) {
        messages = [];
      }
      render();

      syncEnabled = true;
      writeCache();
    } catch (e) {
      /* Could not reach the account's copy. Work from whatever is on screen,
         but leave syncing off so a partial local view can't overwrite good
         server-side history. */
      syncEnabled = false;
      setNotice("Working offline — this conversation won't follow you to another device.", "");
    } finally {
      loading = false;
      setBusy(false);
    }
  }

  /* ---- sending ------------------------------------------------------------ */

  async function send(text) {
    if (busy || loading || exhausted) return;
    var question = text.trim();
    if (!question) return;

    messages.push({ role: "user", text: question });
    els.input.value = "";
    autoGrow();
    render();
    persist();

    setBusy(true);
    setNotice("");
    var thinking = showThinking();

    try {
      var token = window.IntentAuth && IntentAuth.getAccessToken
        ? await IntentAuth.getAccessToken()
        : null;
      if (!token) throw new Error("signed-out");

      var res = await fetch("/api/bio-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ messages: messages }),
      });

      var data = await res.json().catch(function () { return {}; });
      thinking.remove();

      if (res.status === 503 && data.exhausted) {
        messages.pop();                    // nothing was answered; drop the turn
        render();
        persist();
        lockOut(data.error);
        return;
      }

      if (!res.ok) {
        messages.pop();
        render();
        persist();
        setNotice(
          data.error ||
            (res.status === 401
              ? "Your session expired. Please sign in again."
              : "Something went wrong. Please try again."),
          "error"
        );
        return;
      }

      messages.push({ role: "model", text: data.reply });
      render();
      persist();
    } catch (err) {
      thinking.remove();
      messages.pop();
      render();
      setNotice(
        err && err.message === "signed-out"
          ? "Your session expired. Please sign in again."
          : "Couldn't reach the tutor. Check your connection and try again.",
        "error"
      );
    } finally {
      setBusy(false);
      if (!exhausted) els.input.focus();
    }
  }

  function autoGrow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
  }

  /* ---- setup -------------------------------------------------------------- */

  function buildStarters() {
    STARTERS.forEach(function (text) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bio-chip";
      chip.textContent = text;
      chip.addEventListener("click", function () { send(text); });
      els.starters.appendChild(chip);
    });
  }

  function init() {
    var root = document.getElementById("bio-chat");
    if (!root) return;

    els = {
      log: root.querySelector("#bio-log"),
      empty: root.querySelector("#bio-empty"),
      starters: root.querySelector("#bio-starters"),
      form: root.querySelector("#bio-form"),
      input: root.querySelector("#bio-input"),
      send: root.querySelector("#bio-send"),
      clear: root.querySelector("#bio-clear"),
      notice: root.querySelector("#bio-notice"),
    };

    buildStarters();

    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      send(els.input.value);
    });

    /* Enter sends, Shift+Enter makes a new line — the convention students
       already know from every other chat app. */
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(els.input.value);
      }
    });

    els.input.addEventListener("input", autoGrow);

    els.clear.addEventListener("click", function () {
      if (busy || loading) return;
      if (!window.confirm("Start a new conversation? This one will be erased.")) return;
      messages = [];
      render();
      writeCache();
      flush();
      setNotice("");
    });

    // Don't lose the last exchange if the tab closes mid-debounce.
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) flush();
    });

    els.input.placeholder = "Loading your conversation…";
    setBusy(false);   // applies the `loading` lock
    render();
    restore();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
