-- Incremental patch for deployments that already ran an earlier schema.sql.
-- Fresh installs don't need this -- schema.sql now includes both changes.
--
-- Apply with:
--   docker compose exec postgres psql -U postgres -d postgres -f /patches/002-create-workspace.sql
--
-- What it fixes: client-side workspace creation failed because
-- (a) INSERT ... RETURNING on workspaces is gated by the SELECT policy,
--     which required membership -- impossible before the member row exists;
-- (b) the two writes (workspace + owner membership) weren't atomic.
-- Same class of bug as invite acceptance; same style of fix.

drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.workspace_members m
      where m.workspace_id = id and m.user_id = auth.uid()
    )
  );

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

-- PostgREST caches the database schema at startup; without this it won't
-- see functions/tables created after it booted ("Could not find the
-- function ... in the schema cache"). The NOTIFY asks a listening PostgREST
-- to reload; `docker compose restart postgrest` works too.
notify pgrst, 'reload schema';
