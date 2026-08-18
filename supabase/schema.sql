-- ============================================================================
-- Intent United — COMBINED SCHEMA (profiles + chat_sessions + account deletion)
--
-- This file replaces and combines:
--   supabase-schema.sql, chat-continuity-schema.sql, delete-account-schema.sql
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this ->
-- Run. It is idempotent (safe to run more than once, and safe to run over an
-- existing install created by the three older files).
--
-- SECURITY FIX in this revision (section 4):
--   profiles.role was writable by its owner. The row-scoped UPDATE policy
--   ("auth.uid() = id") restricts WHICH ROW you may update but not WHICH
--   COLUMNS, so any signed-in user could PATCH their own profile with
--   {"role":"admin"} straight against the PostgREST API using the public anon
--   key. Fixed by narrowing the UPDATE grant to the `name` column only, with a
--   trigger as defence in depth. Role changes now require service_role.
-- ============================================================================


-- ============================================================================
-- 1. profiles ----------------------------------------------------------------
-- One row per auth user, keyed by auth.users.id.
-- ============================================================================

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text,
  email      text,
  role       text        not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- With RLS on and no policies, every request is denied by default. The
-- policies below are the ONLY things that grant access.
alter table public.profiles enable row level security;

-- Owner-only access.
drop policy if exists "Profiles are viewable by their owner" on public.profiles;
create policy "Profiles are viewable by their owner"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- ============================================================================
-- 2. chat_sessions -----------------------------------------------------------
-- Makes the AI tutor conversation follow the CHILD'S ACCOUNT instead of the
-- browser, so progress continues after a device switch.
--
-- We do NOT have Botpress backend access, so we can't give Botpress a proper
-- signed identity. Instead we back up the Botpress webchat session (which the
-- widget keeps in the browser's localStorage under "bp*" keys) into this table,
-- keyed by the signed-in user. On a new device we restore it before the widget
-- boots, so Botpress resumes the same conversation.
--
-- bp_state is an opaque JSON snapshot; we never interpret its contents.
-- ============================================================================

create table if not exists public.chat_sessions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  bp_state   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chat_sessions enable row level security;

drop policy if exists "Chat sessions are viewable by their owner" on public.chat_sessions;
create policy "Chat sessions are viewable by their owner"
  on public.chat_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own chat session" on public.chat_sessions;
create policy "Users can insert their own chat session"
  on public.chat_sessions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own chat session" on public.chat_sessions;
create policy "Users can update their own chat session"
  on public.chat_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ============================================================================
-- 2b. bio_chats --------------------------------------------------------------
-- The Gemini Biology Tutor on ai.html, which we own end to end. Unlike
-- chat_sessions (an opaque Botpress snapshot), `messages` is a plain array we
-- write ourselves: [ { "role": "user" | "model", "text": "..." }, ... ].
-- Also available on its own in bio-chat-schema.sql.
-- ============================================================================

create table if not exists public.bio_chats (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  messages   jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.bio_chats enable row level security;

drop policy if exists "Bio chats are viewable by their owner" on public.bio_chats;
create policy "Bio chats are viewable by their owner"
  on public.bio_chats for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own bio chat" on public.bio_chats;
create policy "Users can insert their own bio chat"
  on public.bio_chats for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own bio chat" on public.bio_chats;
create policy "Users can update their own bio chat"
  on public.bio_chats for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own bio chat" on public.bio_chats;
create policy "Users can delete their own bio chat"
  on public.bio_chats for delete
  using (auth.uid() = user_id);


-- ============================================================================
-- 3. Shared helpers + triggers -----------------------------------------------
-- ============================================================================

-- Keep updated_at current on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists chat_sessions_set_updated_at on public.chat_sessions;
create trigger chat_sessions_set_updated_at
  before update on public.chat_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists bio_chats_set_updated_at on public.bio_chats;
create trigger bio_chats_set_updated_at
  before update on public.bio_chats
  for each row execute function public.set_updated_at();

-- bio_chats.messages is written straight from the browser, so RLS alone would
-- still let a signed-in user park megabytes in their own row. Cap it
-- server-side. The UI trims to a much smaller window; this is the backstop.
create or replace function public.bio_chats_limit_size()
returns trigger
language plpgsql
as $$
begin
  if jsonb_typeof(new.messages) <> 'array' then
    raise exception 'messages must be a JSON array';
  end if;
  if jsonb_array_length(new.messages) > 200 then
    raise exception 'conversation too long (max 200 messages)';
  end if;
  if octet_length(new.messages::text) > 262144 then
    raise exception 'conversation too large (max 256 KB)';
  end if;
  return new;
end;
$$;

drop trigger if exists bio_chats_limit_size on public.bio_chats;
create trigger bio_chats_limit_size
  before insert or update on public.bio_chats
  for each row execute function public.bio_chats_limit_size();

-- Auto-create a profile row on signup.
-- SECURITY DEFINER lets this run with elevated rights so it can insert the row
-- past RLS. It reads the name we set in auth user_metadata at signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- 4. SECURITY: make profiles.role (and other server-owned columns) immutable
--    to end users.
--
-- Postgres note: a column-level REVOKE has NO effect while a table-level
-- UPDATE grant exists — the table grant still covers every column. So we must
-- revoke UPDATE at the table level first, then re-grant it on `name` only.
-- Supabase's default schema-wide grants give anon/authenticated table-level
-- UPDATE, which is what made the escalation possible.
-- ============================================================================

revoke update on public.profiles from anon, authenticated;
grant  update (name) on public.profiles to authenticated;

-- Defence in depth: even if a future GRANT widens column access, force the
-- server-owned columns back to their previous values on any end-user update.
-- service_role / postgres (SQL editor, admin scripts) are exempt so legitimate
-- role changes still work.
create or replace function public.profiles_protect_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  new.id         := old.id;
  new.role       := old.role;
  new.email      := old.email;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- Must run BEFORE profiles_set_updated_at alphabetically-independent ordering:
-- Postgres fires same-timing triggers in name order, and "profiles_protect_*"
-- sorts before "profiles_set_*", so updated_at is still stamped last.
drop trigger if exists profiles_protect_columns on public.profiles;
create trigger profiles_protect_columns
  before update on public.profiles
  for each row execute function public.profiles_protect_columns();

-- chat_sessions: updated_at is stamped by the trigger, never by the client.
-- user_id must stay grantable because saveChatState() uses an upsert, which
-- compiles to INSERT ... ON CONFLICT DO UPDATE SET user_id = ..., bp_state =
-- ... — revoking UPDATE(user_id) would break saving. That is safe: the RLS
-- WITH CHECK already pins user_id to auth.uid(), so a row can never be moved
-- to another account.
revoke update on public.chat_sessions from anon, authenticated;
grant  update (user_id, bp_state) on public.chat_sessions to authenticated;

-- bio_chats: same reasoning — updated_at is server-owned, user_id must stay
-- grantable for the upsert in saveBioChat().
revoke update on public.bio_chats from anon, authenticated;
grant  update (user_id, messages) on public.bio_chats to authenticated;


-- ============================================================================
-- 5. Self-service account deletion -------------------------------------------
--
-- Lets a signed-in user permanently erase their own account from the browser,
-- with only the public anon key available. Deleting a row from auth.users
-- normally needs the service_role secret (which must NEVER ship to the
-- browser), so we expose exactly one narrow, elevated function instead.
--
-- WHAT GETS ERASED for the calling user:
--   * public.bio_chats row      -> the saved Biology Tutor conversation
--   * public.chat_sessions row  -> the saved AI-tutor conversation + token
--   * public.profiles row       -> name, email, role
--   * auth.users row            -> the login itself (and its refresh tokens,
--                                  identities and sessions, via auth cascades)
--
-- SECURITY: the function takes NO arguments. It always acts on auth.uid() —
-- the caller's own id from their JWT — so one user can never delete another.
-- Execute is granted to `authenticated` only, never to `anon`.
-- ============================================================================

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  delete from public.bio_chats     where user_id = uid;
  delete from public.chat_sessions where user_id = uid;
  delete from public.profiles      where id      = uid;
  delete from auth.users           where id      = uid;
end;
$$;

-- Signed-in users only. `public` includes anon, so strip it explicitly.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;


-- ============================================================================
-- 6. Backfill profiles for any users that already exist ----------------------
-- ============================================================================

insert into public.profiles (id, name, email)
select u.id, coalesce(u.raw_user_meta_data ->> 'name', ''), u.email
from auth.users u
on conflict (id) do nothing;

-- ============================================================================
-- 7. Remediate any escalation that already happened --------------------------
-- Uncomment and run once if you suspect a user granted themselves a role.
-- ============================================================================
-- update public.profiles set role = 'member' where role <> 'member';
