-- ============================================================================
-- Intent United — chat_sessions table + Row Level Security
--
-- PURPOSE: Make the AI tutor conversation follow the CHILD'S ACCOUNT instead of
-- the browser, so progress continues after a device switch.
--
-- We do NOT have Botpress backend access, so we can't give Botpress a proper
-- signed identity. Instead we back up the Botpress webchat session (which the
-- widget keeps in the browser's localStorage under "bp*" keys) into this table,
-- keyed by the signed-in user. On a new device we restore it before the widget
-- boots, so Botpress resumes the same conversation.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this ->
-- Run. Idempotent (safe to run more than once). Run supabase-schema.sql first
-- (or at least once) since both share the set_updated_at() helper.
-- ============================================================================

-- 1. Table -------------------------------------------------------------------
-- One row per user. bp_state is an opaque JSON snapshot of the "bp*" localStorage
-- keys the Botpress widget writes; we never need to interpret its contents.
create table if not exists public.chat_sessions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  bp_state   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Enable Row Level Security -----------------------------------------------
-- With RLS on and no policies, every request is denied by default.
alter table public.chat_sessions enable row level security;

-- 3. Policies: owner-only access ---------------------------------------------
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

drop trigger if exists chat_sessions_set_updated_at on public.chat_sessions;
create trigger chat_sessions_set_updated_at
  before update on public.chat_sessions
  for each row execute function public.set_updated_at();
