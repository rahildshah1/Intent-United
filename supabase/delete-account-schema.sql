-- ============================================================================
-- Intent United — self-service account deletion
--
-- PURPOSE: Let a signed-in user permanently erase their own account from the
-- browser, with only the public anon key available. Deleting a row from
-- auth.users normally needs the service_role secret (which must NEVER ship to
-- the browser), so we expose exactly one narrow, elevated function instead.
--
-- WHAT GETS ERASED for the calling user:
--   * public.chat_sessions row  -> the saved AI-tutor conversation + token
--   * public.profiles row       -> name, email, role
--   * auth.users row            -> the login itself (and its refresh tokens,
--                                  identities and sessions, via auth cascades)
-- The two public tables already declare "references auth.users (id) on delete
-- cascade", so deleting the auth user is enough; they are deleted explicitly
-- first anyway so this stays correct if a future table forgets the cascade.
--
-- SECURITY: the function takes NO arguments. It always acts on auth.uid() —
-- the caller's own id from their JWT — so one user can never delete another.
-- Execute is granted to `authenticated` only, never to `anon`.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this ->
-- Run. Idempotent (safe to run more than once). Run supabase-schema.sql and
-- chat-continuity-schema.sql first.
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

  delete from public.chat_sessions where user_id = uid;
  delete from public.profiles     where id      = uid;
  delete from auth.users          where id      = uid;
end;
$$;

-- Signed-in users only. `public` includes anon, so strip it explicitly.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
