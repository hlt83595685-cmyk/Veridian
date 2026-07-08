#!/bin/sh
# Auto-run once by the official postgres image on first container creation
# (anything under /docker-entrypoint-initdb.d runs before Postgres accepts
# connections from other services -- this guarantees GoTrue/PostgREST can
# authenticate the moment they start, no manual bootstrap step needed).
#
# A .sh script (not .sql) so $POSTGRES_PASSWORD is expanded by the shell
# itself before reaching psql -- sidesteps psql's client-side :'var'
# interpolation entirely, which doesn't work inside dollar-quoted (do $$ ...
# $$) blocks anyway (that was the bug in the original all-in-one schema.sql).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  create extension if not exists pgcrypto;

  do \$\$ begin
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
      create role authenticator noinherit login;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
      create role supabase_auth_admin noinherit createrole login;
    end if;
  end \$\$;

  alter role authenticator password '$POSTGRES_PASSWORD';
  alter role supabase_auth_admin password '$POSTGRES_PASSWORD';

  grant anon to authenticator;
  grant authenticated to authenticator;
  grant service_role to authenticator;
  grant create on database postgres to supabase_auth_admin;

  -- GoTrue's own migrator creates its bookkeeping table
  -- (schema_migrations) unqualified, so it lands wherever
  -- supabase_auth_admin's search_path points -- Postgres defaults that to
  -- "\$user", public, and PG15+ revoked CREATE on public from non-owners
  -- by default, so without this GoTrue fails with "permission denied for
  -- schema public" on its very first connection. Owning + defaulting into
  -- the auth schema fixes both the destination and the permission.
  create schema if not exists auth authorization supabase_auth_admin;
  alter role supabase_auth_admin set search_path = auth;
EOSQL
