# Veridian Control Plane

A minimal, self-hosted subset of Supabase's open-source components --
**Postgres + [GoTrue](https://github.com/supabase/auth) (Auth) +
[PostgREST](https://github.com/PostgREST/postgrest)** -- instead of the full
13-service Supabase stack or Supabase Cloud SaaS. See
`readme/workspace-sync/design.tex` for the full architecture rationale and
`readme/workspace-sync/control-plane-selfhost.tex` for why this specific
subset was chosen.

This is **not** something every Veridian user runs. One admin (whoever owns
the shared workspace) deploys this once; their collaborators' Veridian
clients just point at the resulting URL in Settings → Workspace.

## What this does and doesn't store

- **Does store**: user accounts, workspace membership, roles, invite tokens,
  and — the actual point of this whole thing — which GitHub repository (or
  cloud-folder path) each workspace's data lives in
  (`workspaces.sync_backend_config`).
- **Does not store**: any reference/PDF/markdown data. That lives entirely in
  the GitHub repo or cloud folder each workspace points to. If this server
  disappears, no literature data is lost — only the membership/role records,
  which the admin can recreate.

## Deploy

Any host that can run Docker Compose works: a free-tier VPS (Oracle Cloud
Free Tier, Fly.io, Railway trial), a home server/NAS, or your own machine for
testing.

```bash
cd control-plane
cp .env.example .env
# Fill in POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, SITE_URL, SMTP_*
docker compose up -d
docker compose exec postgres sh -c \
  'psql -U postgres -d postgres -v POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -f /schema.sql'
```

Collaborators' Veridian clients are configured with just the `proxy`
service's public URL (`SITE_URL` above) — that single port (8000) is the only
thing that needs to be reachable from outside the host.

## Admin-only Studio access

`studio` and `postgres-meta` are bound to `127.0.0.1` in `docker-compose.yml`
— they are **never** exposed on the public network. To browse/edit raw
tables yourself:

```bash
ssh -L 3001:127.0.0.1:3001 admin@your-server
# then open http://localhost:3001 in your own browser
```

Regular collaborators never see this dashboard. Their Veridian clients only
ever talk to `proxy:8000`, which fronts just Auth (`/auth/v1/*`) and the
REST API (`/rest/v1/*`) — Row-Level Security policies in `schema.sql` mean
even a compromised client can only see its own workspace's rows.

## No Realtime service

The full Supabase stack's Elixir Realtime service is deliberately omitted —
membership/role changes are rare events, not something that needs
millisecond propagation. Veridian clients poll `workspace_members` on app
launch, before every sync push/pull cycle, and on a manual refresh — good
enough for "a permission change takes effect within a few minutes," not
"instant."

## Inviting someone

Invite creation goes through the app UI (Owner/Admin role required), which
calls PostgREST to insert a row into `invites`. The invite email/link is sent
via the SMTP settings above. Accepting an invite requires signing in with a
matching email (`GOTRUE_DISABLE_SIGNUP=true` means there is no public
self-signup — accounts only come into existence via an accepted invite or an
admin-created one).
