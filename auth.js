/* Intent United — Supabase-backed auth.
   Uses Supabase Auth (email + password) for signup, login, session, and logout.
   Email confirmation is OFF in the Supabase dashboard, so signUp() returns a
   live session immediately — there is no "check your email" step. There is
   also no forgot-password flow: password changes require the current
   password (see changePassword below), not an emailed link.

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
      options: { data: { name: String(name || "").trim() } }
    });
    if (result.error) throw result.error;
    return result.data.user;
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

  // dest lets a caller land somewhere more specific than the bare gate.
  async function logout(dest) {
    clearTutorState();
    await sb.auth.signOut();
    window.location.href = dest || "login.html";
  }

  /* Change the signed-in user's password. Requires the current password
     (re-verified via signInWithPassword) rather than an emailed link — there
     is no forgot-password flow on this site. */
  async function changePassword(currentPassword, newPassword) {
    var session = await sb.auth.getSession();
    if (!session.data.session) throw new Error("You must be signed in.");
    var email = session.data.session.user.email;

    var check = await sb.auth.signInWithPassword({ email: email, password: currentPassword });
    if (check.error) throw new Error("Your current password is incorrect.");

    var result = await sb.auth.updateUser({ password: newPassword });
    if (result.error) throw result.error;
    return result.data.user;
  }

  // Turn a Supabase auth error into a message safe to show a user.
  function describeAuthError(err) {
    if (!err) return "Something went wrong. Please try again.";
    return err.message || "Something went wrong. Please try again.";
  }

  /* Permanently erase the signed-in user's account.

     Everything happens inside the delete_own_account() Postgres function
     (see supabase/delete-account-schema.sql), which runs with elevated rights and
     always targets auth.uid() — the caller's own id. It removes the saved
     chat session (conversation + token), the Biology Tutor transcript, the
     profile row, and the auth user itself. There is no undo. */
  async function deleteAccount() {
    var session = await sb.auth.getSession();
    if (!session.data.session) throw new Error("You must be signed in.");

    var result = await sb.rpc("delete_own_account");
    if (result.error) throw result.error;

    // Both tutors cache their conversation in this browser (Botpress under
    // "bp*" keys, the biology chat under "iu_bio_chat"). Clear them so the
    // next account on this device starts fresh.
    clearTutorState();

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
    clearTutorState();
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

  /* The signed-in user's JWT. The Biology Tutor Worker takes this as a Bearer
     token and checks it with Supabase before spending any Gemini quota, so
     only real accounts can draw on the site's shared daily budget. */
  async function getAccessToken() {
    var result = await sb.auth.getSession();
    return result.data.session ? result.data.session.access_token : null;
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

  /* ---- Biology Tutor history (bio_chats table, owner-only via RLS) ---- */
  /* The Gemini biology chat on ai.html is ours end to end, so unlike the
     Botpress snapshot above we store the transcript itself:
       [ { role: "user" | "model", text: "..." }, ... ]
     Saved per account so a conversation started in a classroom continues on
     another device. */

  // Return the signed-in user's saved biology transcript, or null.
  async function getBioChat() {
    var session = await sb.auth.getSession();
    if (!session.data.session) return null;
    var result = await sb
      .from("bio_chats")
      .select("messages")
      .eq("user_id", session.data.session.user.id)
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data ? result.data.messages : null;
  }

  // Upsert the biology transcript for the signed-in user.
  async function saveBioChat(messages) {
    var session = await sb.auth.getSession();
    if (!session.data.session) return;
    var result = await sb
      .from("bio_chats")
      .upsert({ user_id: session.data.session.user.id, messages: messages || [] });
    if (result.error) throw result.error;
  }

  /* Drop the biology transcript from THIS browser. Same shared-device concern
     as clearBotpressState: the cache is only a fast path for the account that
     wrote it, so every sign-out path clears it. The server-side row is left
     alone — that is the account's copy, and it is restored on next sign-in. */
  function clearBioChatState() {
    try { localStorage.removeItem("iu_bio_chat"); } catch (e) { /* storage blocked */ }
  }

  // Everything a sign-out must wipe from this device.
  function clearTutorState() {
    clearBotpressState();
    clearBioChatState();
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
    getBioChat: getBioChat,
    saveBioChat: saveBioChat,
    getUser: getUser,
    getAccessToken: getAccessToken,
    clearBotpressState: clearBotpressState,
    clearBioChatState: clearBioChatState,
    clearTutorState: clearTutorState,
    deleteAccount: deleteAccount,
    changePassword: changePassword,
    describeAuthError: describeAuthError
  };
})(window);
