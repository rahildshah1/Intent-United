/* Intent United — Supabase-backed auth.
   Uses Supabase Auth (email + password) for signup, login, session, and logout.
   The client is created from window.SUPABASE_URL / window.SUPABASE_ANON_KEY,
   provided by config.js (gitignored). The anon key is a public, RLS-protected
   key and is safe in the browser. NEVER load the service_role/secret key here.

   Load order on every page (in <head>):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="config.js"></script>
     <script src="auth.js"></script>
   Protected pages then call IntentAuth.requireAuth();
   The login page calls IntentAuth.redirectIfAuthed('index.html'); */

(function (global) {
  "use strict";

  if (!global.supabase || !global.supabase.createClient) {
    console.error("Supabase library failed to load (check the CDN <script> tag).");
    return;
  }
  if (!global.SUPABASE_URL || !global.SUPABASE_ANON_KEY) {
    console.error("Missing Supabase config. Copy config.example.js to config.js and fill it in.");
    return;
  }

  var sb = global.supabase.createClient(global.SUPABASE_URL, global.SUPABASE_ANON_KEY);

  /* The client consumes and then strips any auth tokens in the URL as soon as
     it boots, so snapshot the address now — the recovery flow below still
     needs to read what the emailed link carried. */
  var INITIAL_HASH = global.location.hash;
  var INITIAL_SEARCH = global.location.search;

  function whenReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  /* ---- account operations ------------------------------------------- */

  async function register(name, email, password) {
    var result = await sb.auth.signUp({
      email: String(email).trim(),
      password: password,
      options: {
        data: { name: String(name || "").trim() },
        // Where the confirmation-email link sends the user back to.
        emailRedirectTo: new URL("login.html", window.location.href).href
      }
    });
    if (result.error) throw result.error;
    // With "Confirm email" on, signUp returns a user but no session yet.
    return { needsConfirmation: !result.data.session };
  }

  async function login(email, password) {
    var result = await sb.auth.signInWithPassword({
      email: String(email).trim(),
      password: password
    });
    if (result.error) throw result.error;
    return result.data.user;
  }

  /* Remove the Botpress widget's session keys ("bp*") from THIS browser.
     Those keys hold the conversation id and the widget's user token, so they
     must never outlive the session that created them: on a shared device (a
     partner center, a classroom laptop) leftover keys would let the next
     child to sign in resume the previous child's tutor conversation — and
     ai.html would then upload that conversation into the new child's account.
     Every sign-out path calls this. */
  function clearBotpressState() {
    try {
      var stale = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf("bp") === 0) stale.push(key);
      }
      stale.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* storage blocked — nothing to clean up */ }
  }

  // dest lets a caller land somewhere more specific than the bare gate,
  // e.g. login.html?reset=1 after a password change.
  async function logout(dest) {
    clearBotpressState();
    await sb.auth.signOut();
    window.location.href = dest || "login.html";
  }

  /* ---- password reset ------------------------------------------------ */
  /* Two halves, on two pages:
       1. login.html  -> sendPasswordReset() emails a one-time recovery link
       2. reset-password.html -> startPasswordRecovery() turns the token in
          that link into a short-lived session, then updatePassword() sets the
          new password on it. */

  async function sendPasswordReset(email) {
    var result = await sb.auth.resetPasswordForEmail(String(email).trim(), {
      redirectTo: new URL("reset-password.html", window.location.href).href
    });
    if (result.error) throw result.error;
  }

  /* Establish the recovery session the emailed link carries. Throws with a
     readable message when the link is expired, already used, or malformed. */
  async function startPasswordRecovery() {
    var hash = new URLSearchParams(String(INITIAL_HASH).replace(/^#/, ""));
    var query = new URLSearchParams(INITIAL_SEARCH);

    // Supabase reports a dead link as error/error_description on the URL.
    var errDesc = hash.get("error_description") || query.get("error_description");
    if (errDesc) throw new Error(errDesc);

    // PKCE links carry ?code=, older implicit-flow links carry
    // #access_token=&refresh_token=, and both may carry type=recovery.
    var code = query.get("code");
    var hasImplicitToken = !!hash.get("access_token");
    var isRecoveryLink = !!(code || hasImplicitToken ||
      hash.get("type") === "recovery" || query.get("type") === "recovery");

    /* Require an actual recovery link. Without this, getSession() below would
       be satisfied by ANY ordinary signed-in session, so anyone with brief
       access to an unlocked browser could open this page directly and set a
       new password without knowing the current one — a full account takeover
       from a shared or unattended device. */
    if (!isRecoveryLink) {
      throw new Error("Open the reset link from your email to set a new password.");
    }

    // The client usually picks the token up on its own (detectSessionInUrl).
    var session = await sb.auth.getSession();
    if (!session.data.session) {
      // Otherwise redeem it by hand.
      if (code) {
        var exchanged = await sb.auth.exchangeCodeForSession(code);
        if (exchanged.error) throw exchanged.error;
      } else if (hash.get("access_token")) {
        var restored = await sb.auth.setSession({
          access_token: hash.get("access_token"),
          refresh_token: hash.get("refresh_token")
        });
        if (restored.error) throw restored.error;
      }
      session = await sb.auth.getSession();
    }

    if (!session.data.session) {
      throw new Error("This reset link is invalid or has expired. Request a new one.");
    }

    // Don't leave a usable token sitting in the address bar / history.
    try {
      history.replaceState(null, "", window.location.pathname);
    } catch (e) { /* non-fatal */ }
  }

  /* Set a new password on the current session (recovery or normal sign-in). */
  async function updatePassword(newPassword) {
    var result = await sb.auth.updateUser({ password: newPassword });
    if (result.error) throw result.error;
    return result.data.user;
  }

  /* Permanently erase the signed-in user's account.

     Everything happens inside the delete_own_account() Postgres function
     (see supabase/delete-account-schema.sql), which runs with elevated rights and
     always targets auth.uid() — the caller's own id. It removes the saved
     chat session (conversation + token), the profile row, and the auth user
     itself. There is no undo. */
  async function deleteAccount() {
    var session = await sb.auth.getSession();
    if (!session.data.session) throw new Error("You must be signed in.");

    var result = await sb.rpc("delete_own_account");
    if (result.error) throw result.error;

    // The Botpress widget caches the conversation under "bp*" keys in this
    // browser. Clear them so the next account on this device starts fresh.
    clearBotpressState();

    // The server-side user is already gone, so signOut may fail; all we still
    // need is the local token cleared, which signOut does before the request.
    try { await sb.auth.signOut(); } catch (e) { /* best-effort */ }
  }

  /* ---- idle auto-logout (security) ---------------------------------- */
  /* After this much inactivity the session is signed out automatically so an
     unattended, long-running session can't be picked up by someone else. Any
     real interaction (move, key, scroll, tap, click) resets the countdown. */
  var IDLE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes
  var idleTimer = null;
  var idleStarted = false;

  async function idleSignOut() {
    clearBotpressState();
    try { await sb.auth.signOut(); } catch (e) { /* sign out best-effort */ }
    var dest = new URL("login.html", window.location.href);
    dest.searchParams.set("timeout", "1");
    window.location.replace(dest.href);
  }

  function startIdleLogout() {
    if (idleStarted) return;
    idleStarted = true;

    function reset() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = window.setTimeout(idleSignOut, IDLE_LIMIT_MS);
    }

    ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"]
      .forEach(function (evt) {
        window.addEventListener(evt, reset, { passive: true });
      });

    // Coming back to a tab that slept in the background also counts as activity.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) reset();
    });

    reset();
  }

  async function getUser() {
    var result = await sb.auth.getSession();
    return result.data.session ? result.data.session.user : null;
  }

  async function isLoggedIn() {
    return !!(await getUser());
  }

  /* ---- profiles (public.profiles table, owner-only via RLS) --------- */

  // Fetch the signed-in user's profile row. Returns null if not signed in.
  async function getProfile() {
    var session = await sb.auth.getSession();
    if (!session.data.session) return null;
    var result = await sb
      .from("profiles")
      .select("id, name, email, role, created_at, updated_at")
      .eq("id", session.data.session.user.id)
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  // Update editable fields on the signed-in user's profile (e.g. { name }).
  async function updateProfile(fields) {
    var session = await sb.auth.getSession();
    if (!session.data.session) throw new Error("You must be signed in.");
    var result = await sb
      .from("profiles")
      .update(fields)
      .eq("id", session.data.session.user.id)
      .select()
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  /* ---- chat continuity (chat_sessions table, owner-only via RLS) ----- */
  /* The AI tutor is a Botpress widget that keeps its whole session in this
     browser's localStorage. To make progress follow the CHILD'S ACCOUNT across
     devices, we back that session up here and restore it on another device.
     bp_state is an opaque snapshot; we never interpret it. */

  // Return the saved Botpress session snapshot for the signed-in user, or null.
  async function getChatState() {
    var session = await sb.auth.getSession();
    if (!session.data.session) return null;
    var result = await sb
      .from("chat_sessions")
      .select("bp_state")
      .eq("user_id", session.data.session.user.id)
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data ? result.data.bp_state : null;
  }

  // Upsert the Botpress session snapshot for the signed-in user.
  async function saveChatState(state) {
    var session = await sb.auth.getSession();
    if (!session.data.session) return;
    var result = await sb
      .from("chat_sessions")
      .upsert({ user_id: session.data.session.user.id, bp_state: state });
    if (result.error) throw result.error;
  }

  /* Protect a page: hide it until a session is confirmed; redirect to the gate
     if there is none. Runs from <head>, so it hides <html> synchronously first
     to avoid any flash of protected content. */
  async function requireAuth() {
    document.documentElement.style.visibility = "hidden";
    var user = null;
    try {
      user = await getUser();
    } catch (e) {
      user = null;
    }
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    document.documentElement.style.visibility = "";
    whenReady(function () { enhanceNav(user); startIdleLogout(); });
  }

  /* On the login page: if already signed in, skip straight to the site. */
  async function redirectIfAuthed(dest) {
    try {
      if (await isLoggedIn()) window.location.replace(dest || "index.html");
    } catch (e) { /* stay on the login page */ }
  }

  /* ---- nav enhancement ---------------------------------------------- */

  function enhanceNav(user) {
    var list = document.querySelector("header nav ul");
    if (!list || list.querySelector(".nav-logout")) return;

    var meta = (user && user.user_metadata) || {};
    var name = meta.name || "";
    var firstName = name ? name.split(" ")[0] : "there";

    // The greeting doubles as the way into the account page (profile + delete).
    var greet = document.createElement("li");
    greet.className = "nav-greeting";
    var greetLink = document.createElement("a");
    greetLink.href = "account.html";
    greetLink.textContent = "Hi, " + firstName;
    greetLink.title = "Your account";
    greet.appendChild(greetLink);

    var logoutItem = document.createElement("li");
    logoutItem.className = "nav-logout";
    var link = document.createElement("a");
    link.href = "#";
    link.textContent = "Log out";
    link.addEventListener("click", function (e) {
      e.preventDefault();
      logout();
    });
    logoutItem.appendChild(link);

    list.appendChild(greet);
    list.appendChild(logoutItem);
  }

  global.IntentAuth = {
    register: register,
    login: login,
    logout: logout,
    isLoggedIn: isLoggedIn,
    requireAuth: requireAuth,
    redirectIfAuthed: redirectIfAuthed,
    getProfile: getProfile,
    updateProfile: updateProfile,
    getChatState: getChatState,
    saveChatState: saveChatState,
    clearBotpressState: clearBotpressState,
    deleteAccount: deleteAccount,
    sendPasswordReset: sendPasswordReset,
    startPasswordRecovery: startPasswordRecovery,
    updatePassword: updatePassword
  };
})(window);
