-- Veridian control-plane schema. Bootstraps the standard Postgres roles that
-- GoTrue and PostgREST expect (this file exists because we deliberately used
-- vanilla postgres:16-alpine instead of the supabase/postgres image, which
-- ships these pre-installed -- keeping everything explicit and auditable in
-- one file rather than depending on hidden image-specific setup).
--
-- Run once after `docker compose up -d`:
--   docker compose exec postgres sh -c \
--     'psql -U postgres -d postgres -v POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -f /schema.sql'

-- ── Roles ─────────────────────────────────────────────────────────────────────
-- authenticator: what PostgREST connects as; NOINHERIT so it must explicitly
-- SET ROLE to anon/authenticated per-request based on the verified JWT.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password :'POSTGRES_PASSWORD';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin noinherit createrole login password :'POSTGRES_PASSWORD';
  end if;
end $$;

grant anon to authenticator;
grant authenticated to authenticator;
grant service_role to authenticator;
grant create on database postgres to supabase_auth_admin;

-- ── auth.uid() / auth.role() helpers ─────────────────────────────────────────
-- PostgREST decodes the incoming JWT and sets request.jwt.claims as a GUC
-- before running the request's SQL. These mirror Supabase's own convention so
-- RLS policies read naturally, and match what @supabase/supabase-js expects.
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'role', '')
$$;

create or replace function auth.email() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'email', '')
$$;

-- ── Application tables ────────────────────────────────────────────────────────
create type workspace_kind as enum ('private', 'shared');
create type member_role    as enum ('owner', 'admin', 'editor', 'viewer');
create type invite_status  as enum ('pending', 'accepted', 'revoked');
create type sync_backend   as enum ('git', 'cloud_folder');

-- GoTrue's user table (auth.users) is not exposed via PostgREST (only the
-- `public` schema is, per PGRST_DB_SCHEMAS), and reading someone else's email
-- normally requires the service_role key, which clients never hold. Mirror
-- just the display-relevant fields into `public` so member lists can embed
-- them via a normal FK join, kept in sync by the trigger below.
create table public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text not null
);

alter table public.profiles enable row level security;
-- Any authenticated user can see the basic profile of any other authenticated
-- user -- this is a small, invite-only control plane for known collaborators,
-- not a public directory; the actual workspace/data access boundary is
-- enforced by the workspace_members/workspaces policies below, not by
-- hiding profile existence.
create policy profiles_select on public.profiles for select
  using (auth.role() = 'authenticated');
grant select on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The single most important table: which GitHub repo (or cloud-folder path)
-- backs each workspace. This -- not a general content store -- is the control
-- plane's actual job (see readme/workspace-sync/design.tex §1, §3.2).
create table public.workspaces (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  kind                workspace_kind not null default 'private',
  owner_id            uuid not null references public.profiles(id),
  sync_backend_type   sync_backend not null,
  -- Non-secret connection info only (repo URL, folder path). Tokens/PATs
  -- never live here -- they stay client-side, encrypted via safeStorage
  -- (see design.tex §5.2).
  sync_backend_config jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id),
  role         member_role not null default 'viewer',
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null,
  role         member_role not null default 'viewer',
  token        text not null unique default encode(gen_random_bytes(24), 'base64url'),
  status       invite_status not null default 'pending',
  expires_at   timestamptz not null default (now() + interval '7 days'),
  created_at   timestamptz not null default now()
);

create table public.devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  device_name    text not null,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now()
);

-- ── Row-Level Security ────────────────────────────────────────────────────────
-- Second line of defense beneath the app-level PermissionSource checks
-- (design.tex §5.1) -- even a bug in the client can't leak another
-- workspace's membership or invite tokens.
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.invites           enable row level security;
alter table public.devices           enable row level security;

-- workspaces: visible to members; mutable only by the owner
create policy workspaces_select on public.workspaces for select
  using (exists (
    select 1 from public.workspace_members m
    where m.workspace_id = id and m.user_id = auth.uid()
  ));

create policy workspaces_update on public.workspaces for update
  using (owner_id = auth.uid());

create policy workspaces_delete on public.workspaces for delete
  using (owner_id = auth.uid());

create policy workspaces_insert on public.workspaces for insert
  with check (owner_id = auth.uid());

-- workspace_members: members can see their fellow members; only
-- owner/admin can add/remove/change roles (enforced by role-check subquery)
--
-- NOTE: the target table's own column must be qualified with its table name
-- (workspace_members.workspace_id) inside the subquery below. Left bare, it
-- would resolve to the subquery's own `me.workspace_id` (inner scope shadows
-- outer scope for identical column names), turning the check into the
-- tautology `me.workspace_id = me.workspace_id` -- which would let any
-- owner/admin of *any* workspace read/write *every* workspace's membership.
create policy members_select on public.workspace_members for select
  using (exists (
    select 1 from public.workspace_members me
    where me.workspace_id = workspace_members.workspace_id and me.user_id = auth.uid()
  ));

create policy members_write on public.workspace_members for all
  using (exists (
    select 1 from public.workspace_members me
    where me.workspace_id = workspace_members.workspace_id and me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.workspace_members me
    where me.workspace_id = workspace_members.workspace_id and me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
  ));

-- invites: workspace owner/admin manage them; the invited person can read
-- (and accept) their own pending invite once authenticated with a matching
-- email, even before they're a member of anything.
-- Same shadowing hazard as above: invites.workspace_id must be qualified,
-- since the workspace_members subquery has its own workspace_id column.
create policy invites_admin on public.invites for all
  using (exists (
    select 1 from public.workspace_members m
    where m.workspace_id = invites.workspace_id and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ));

create policy invites_self_accept on public.invites for select
  using (email = auth.email() and status = 'pending');

-- devices: strictly private to their owner
create policy devices_own on public.devices for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Grants ────────────────────────────────────────────────────────────────────
-- anon can only look up an invite by its token (to render "you've been
-- invited" before the user has even signed in) -- nothing else.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.invites to anon;

grant select, insert, update, delete on public.workspaces        to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.invites           to authenticated;
grant select, insert, update, delete on public.devices           to authenticated;

grant usage on schema auth to authenticator, anon, authenticated, service_role;
