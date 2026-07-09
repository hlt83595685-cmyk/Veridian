-- Veridian control-plane schema -- part 2 of 2.
--
-- Part 1 (init/01-roles.sh: anon/authenticated/authenticator/
-- supabase_auth_admin roles + the pgcrypto extension) runs AUTOMATICALLY on
-- first container creation, via Postgres's own docker-entrypoint-initdb.d
-- mechanism -- no manual step, no password-substitution quoting to get
-- wrong. This file depends on those roles already existing, AND on GoTrue
-- having successfully connected at least once and run its own internal
-- migrations (which create the auth.users table this file's `profiles`
-- table references) -- so run this *after* `docker compose up -d`, once
-- `docker compose logs gotrue` shows it started cleanly (a few seconds is
-- enough):
--
--   docker compose exec postgres psql -U postgres -d postgres -f /schema.sql
--
-- No -v / password substitution needed here at all.

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

-- workspaces: visible to members (and always to the owner -- membership
-- alone isn't enough as the SELECT gate, because Postgres applies SELECT
-- policies to INSERT ... RETURNING too, and at creation time the owner's
-- membership row doesn't exist yet); mutable only by the owner
create policy workspaces_select on public.workspaces for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.workspace_members m
      where m.workspace_id = id and m.user_id = auth.uid()
    )
  );

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

-- Bootstrap case: members_write above requires you to ALREADY be an
-- owner/admin member before you can insert a membership row -- which can
-- never be satisfied for the very first row of a brand-new workspace (you'd
-- need to already be a member to become a member). This lets the workspace's
-- owner (per workspaces.owner_id, set at creation time) insert their own
-- initial 'owner' row exactly once.
create policy members_insert_owner on public.workspace_members for insert
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );

-- invites: workspace owner/admin manage them; the invited person can read
-- their own pending invite once authenticated with a matching email (to
-- preview "you've been invited to X"), even before they're a member of
-- anything. Same shadowing hazard as above: invites.workspace_id must be
-- qualified, since the workspace_members subquery has its own workspace_id
-- column.
create policy invites_admin on public.invites for all
  using (exists (
    select 1 from public.workspace_members m
    where m.workspace_id = invites.workspace_id and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ));

create policy invites_self_accept on public.invites for select
  using (email = auth.email() and status = 'pending');

-- Accepting an invite needs to (a) insert the invitee's own membership row
-- and (b) flip the invite to 'accepted', atomically. Neither step is safely
-- expressible as a plain client-side RLS-gated write: the invitee isn't yet
-- a member (so members_write's "must already be owner/admin" check fails,
-- same bootstrap problem as above) and a raw client-side UPDATE on invites
-- can't be restricted to "only the status column may change" through RLS
-- alone (a client could smuggle role='owner' into the same request). A
-- security-definer function does the validation once, server-side, and
-- performs both writes as a single transaction.
create or replace function public.accept_workspace_invite(p_token text)
returns public.workspaces
language plpgsql
security definer set search_path = public
as $$
declare
  v_invite public.invites;
  v_ws     public.workspaces;
begin
  select * into v_invite from public.invites
    where token = p_token and status = 'pending'
    for update;

  if not found then
    raise exception 'Invite not found or already used';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'Invite has expired';
  end if;
  if v_invite.email <> auth.email() then
    raise exception 'This invite was sent to a different email address';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, auth.uid(), v_invite.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  update public.invites set status = 'accepted' where id = v_invite.id;

  select * into v_ws from public.workspaces where id = v_invite.workspace_id;
  return v_ws;
end;
$$;

grant execute on function public.accept_workspace_invite(text) to authenticated;

-- Workspace creation has the same shape as invite acceptance: two writes
-- (the workspace row + the creator's own 'owner' membership row) that must
-- land atomically, where the second write's RLS gate depends on the first
-- having happened. Doing it client-side also trips over INSERT ...
-- RETURNING requiring SELECT-policy visibility. One security-definer
-- function, both writes, one transaction.
create or replace function public.create_workspace(
  p_name text, p_kind workspace_kind, p_backend sync_backend, p_config jsonb
)
returns public.workspaces
language plpgsql
security definer set search_path = public
as $$
declare
  v_ws public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Workspace name is required';
  end if;

  insert into public.workspaces (name, kind, owner_id, sync_backend_type, sync_backend_config)
  values (trim(p_name), p_kind, auth.uid(), p_backend, coalesce(p_config, '{}'::jsonb))
  returning * into v_ws;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, auth.uid(), 'owner');

  return v_ws;
end;
$$;

grant execute on function public.create_workspace(text, workspace_kind, sync_backend, jsonb) to authenticated;

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
