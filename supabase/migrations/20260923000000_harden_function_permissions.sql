-- Keep trigger and event-trigger functions inaccessible through the public API.
revoke execute on function public.capture_sync_change() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- Resolve function names through trusted built-ins only.
alter function public.get_server_time() set search_path = pg_catalog;
