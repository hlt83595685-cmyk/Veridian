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

## 1. Deploy

Any host that can run Docker Compose works: a free-tier VPS (Oracle Cloud
Free Tier, Fly.io, Railway trial), a home server/NAS, or your own machine
(`localhost`) for testing.

```bash
cd control-plane
node scripts/generate-keys.mjs "$(openssl rand -base64 48)" > /tmp/keys.txt
cat /tmp/keys.txt   # copy the JWT_SECRET you passed in, plus the two printed keys

cp .env.example .env
# Fill in: the JWT_SECRET you generated, ANON_KEY, SERVICE_ROLE_KEY from
# scripts/generate-keys.mjs's output, POSTGRES_PASSWORD (any long random
# string), SITE_URL (http://localhost:8000 for local testing), and SMTP_*
# (can be left blank for local testing -- password-reset emails just won't
# send; sign-in/sign-up still work).

docker compose up -d
docker compose exec postgres sh -c \
  'psql -U postgres -d postgres -v POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -f /schema.sql'
```

## 2. Connect Veridian and create your own account

By default (`GOTRUE_DISABLE_SIGNUP=false` in `docker-compose.yml`), anyone
who knows your control plane's URL + anon key can sign up — this is
deliberately harmless: a freshly signed-up account with zero workspace
invites can see and do nothing (every workspace/data query is gated by a
`workspace_members` row). So for local testing, or a small trusted team, just:

1. Open Veridian → **Settings → Workspace**.
2. Paste your `SITE_URL` (e.g. `http://localhost:8000`) and `ANON_KEY` →
   **Save Connection**.
3. Click **"Don't have an account? Sign up"**, enter any email + password →
   **Sign Up** → then sign in.

This first account you create *is* your admin account — there's no separate
"admin login." Being an admin just means: you're the `owner_id` of the
workspaces you create, and you hold the `.env` secrets (`SERVICE_ROLE_KEY`,
SSH access) that let you manage the server itself. Regular collaborators
never need any of that — they only ever need the `SITE_URL` + `ANON_KEY` (not
secret; safe to hand out) plus an in-app workspace invite code from you.

## 3. Test the full collaboration flow

You need a second email address to simulate a collaborator (a `+alias`
address on your own inbox works fine, e.g. `you+collab@gmail.com`, since
GoTrue treats it as a distinct account).

1. Signed in as yourself: **Workspace switcher → Manage Workspaces… → New
   Workspace**. Give it a name, pick "Shared" and a backend (the backend
   fields don't need to point anywhere real yet — data-plane sync isn't
   implemented, see below).
2. Click the new workspace in the list → **Invite Member** → enter your
   second test email + a role → **Invite Member**. A code appears — copy it
   (this is also visible any time under **Pending Invites**).
3. Sign out (Settings → Workspace → Sign Out), sign up with the *second*
   email, sign back in.
4. **Manage Workspaces…** → paste the invite code into **Accept Invite** →
   **Join**. The workspace now appears for this account too.
5. Back on your own (owner) account, open the workspace's Members tab — the
   second account should now be listed with the role you invited it as, and
   you can change its role or remove it.

## 4. Admin-only Studio access

`studio` and `postgres-meta` are bound to `127.0.0.1` in `docker-compose.yml`
— they are **never** exposed on the public network. To browse/edit raw
tables yourself on a remote server:

```bash
ssh -L 3001:127.0.0.1:3001 admin@your-server
# then open http://localhost:3001 in your own browser
```

Regular collaborators never see this dashboard. Their Veridian clients only
ever talk to `proxy:8000`, which fronts just Auth (`/auth/v1/*`) and the
REST API (`/rest/v1/*`) — Row-Level Security policies in `schema.sql` mean
even a compromised client can only see its own workspace's rows.

## 5. Locking down signup (optional, for public-IP deployments)

If you deploy somewhere with a public IP and don't want strangers creating
even harmless empty accounts, set `GOTRUE_DISABLE_SIGNUP=true` in
`docker-compose.yml` and `docker compose up -d` again. With signup disabled,
nobody (including you) can sign up from the app anymore — create accounts
instead with the admin script, which uses `SERVICE_ROLE_KEY` (never given to
any client):

```bash
node scripts/invite-user.mjs http://your-server:8000 <SERVICE_ROLE_KEY> someone@example.com
```

This prints a temporary password to relay to them out-of-band. They sign in
with it from Settings → Workspace (there's no self-service "change password"
UI yet — a follow-up).

## No Realtime service

The full Supabase stack's Elixir Realtime service is deliberately omitted —
membership/role changes are rare events, not something that needs
millisecond propagation. Veridian clients poll `workspace_members` on app
launch, before every sync push/pull cycle, and on a manual refresh — good
enough for "a permission change takes effect within a few minutes," not
"instant."

## Known gaps (not yet implemented)

- **Data-plane sync** (`SyncEngine`, `GitSyncBackend`, `CloudFolderSyncBackend`
  from `readme/workspace-sync/design.tex` §4): workspaces can be created and
  staffed with members/roles, but no literature data actually moves between
  collaborators yet.
- **Invite emails**: creating an invite does not send anything automatically
  — the inviter must copy the code from the UI and relay it themselves.
- **Password reset / change**: not built; relies on SMTP + GoTrue's own
  recovery flow if configured, otherwise unavailable.
