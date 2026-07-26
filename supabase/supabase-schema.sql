-- ============================================================================
-- Intent United — profiles table + Row Level Security
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this ->
-- Run. It is idempotent (safe to run more than once).
--
-- What it does:
--   * profiles: one row per auth user, keyed by auth.users.id
--   * RLS: a signed-in user can read/insert/update ONLY their own row
--   * a trigger auto-creates a profile whenever a new user signs up
--   * updated_at is kept fresh automatically
--   * existing users are backfilled at the end
-- ============================================================================

-- 1. Table -------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text,
  email      text,
  role       text        not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Enable Row Level Security -----------------------------------------------
-- With RLS on and no policies, every request is denied by default. The
-- policies below are the ONLY things that grant access.
alter table public.profiles enable row level security;

-- 3. Policies: owner-only access ---------------------------------------------
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

-- 4. Auto-create a profile row on signup -------------------------------------
-- SECURITY DEFINER lets this run with elevated rights so it can insert the
-- row past RLS. It reads the name we set in auth user_metadata at signup.
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

-- 5. Keep updated_at current on every change ---------------------------------
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

-- 6. Backfill profiles for any users that already exist ----------------------
insert into public.profiles (id, name, email)
select u.id, coalesce(u.raw_user_meta_data ->> 'name', ''), u.email
from auth.users u
on conflict (id) do nothing;
