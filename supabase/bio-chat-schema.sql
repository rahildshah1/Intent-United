-- ============================================================================
-- Intent United — bio_chats table + Row Level Security
--
-- PURPOSE: Make the Biology Tutor conversation on ai.html follow the CHILD'S
-- ACCOUNT rather than the browser, the same way chat_sessions does for the
-- Botpress tutor. A student can start a conversation on a shared classroom
-- laptop and pick it up on a phone.
--
-- Unlike chat_sessions (an opaque snapshot of Botpress's localStorage), we own
-- this conversation outright, so `messages` is a plain JSON array we write:
--   [ { "role": "user" | "model", "text": "..." }, ... ]
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this ->
-- Run. Idempotent (safe to run more than once). Run schema.sql first, or at
-- least once, since both share the set_updated_at() helper.
--
-- Already ran schema.sql? This file is also folded into it, so running the
-- updated schema.sql instead of this one gets you the same result.
-- ============================================================================

-- 1. Table -------------------------------------------------------------------
-- One row per user. The trigger in section 5 caps how much a single account
-- can store, so a long-running conversation cannot grow without bound.
create table if not exists public.bio_chats (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  messages   jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Enable Row Level Security -----------------------------------------------
-- With RLS on and no policies, every request is denied by default.
alter table public.bio_chats enable row level security;

-- 3. Policies: owner-only access ---------------------------------------------
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

-- 4. Keep updated_at current on every change ---------------------------------
-- Redefined here so this file is self-contained if run on its own.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bio_chats_set_updated_at on public.bio_chats;
create trigger bio_chats_set_updated_at
  before update on public.bio_chats
  for each row execute function public.set_updated_at();

-- 5. Size guard --------------------------------------------------------------
-- `messages` is written straight from the browser, so RLS alone would still let
-- a signed-in user park megabytes in their own row. Cap it server-side. The UI
-- trims to a much smaller window; this is the backstop, not the policy.
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

-- 6. Column grants -----------------------------------------------------------
-- updated_at is stamped by the trigger, never by the client. user_id stays
-- grantable because saveBioChat() upserts, which compiles to
-- INSERT ... ON CONFLICT DO UPDATE SET user_id = ..., messages = ...; the RLS
-- WITH CHECK already pins user_id to auth.uid(), so a row can never be moved
-- to another account.
revoke update on public.bio_chats from anon, authenticated;
grant  update (user_id, messages) on public.bio_chats to authenticated;

-- 7. Fold into account deletion ----------------------------------------------
-- delete_own_account() must erase this conversation too. Redefined in full so
-- this file can be run on its own; identical to the copy in schema.sql.
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

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
