-- Keep existing attendance data. Initialize one shared schedule for all browsers.
create table if not exists public.prayer_schedule (
  id integer primary key check (id = 1),
  enabled boolean not null default true,
  start_time time not null default '11:30',
  end_time time not null default '15:00',
  constraint prayer_schedule_time_order check (start_time < end_time)
);

insert into public.prayer_schedule (id) values (1) on conflict (id) do nothing;

alter table public.prayer_schedule enable row level security;

-- Match existing demo login policies. Replace with authenticated teacher access when login migrates to Supabase Auth.
drop policy if exists "public can read prayer schedule" on public.prayer_schedule;
drop policy if exists "public can update prayer schedule" on public.prayer_schedule;
create policy "public can read prayer schedule" on public.prayer_schedule for select using (true);
create policy "public can update prayer schedule" on public.prayer_schedule for update using (true) with check (true);
grant select, update on public.prayer_schedule to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'prayer_schedule'
  ) then alter publication supabase_realtime add table public.prayer_schedule; end if;
end $$;
