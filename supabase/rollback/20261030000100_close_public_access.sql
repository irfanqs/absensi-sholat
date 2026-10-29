-- Rollback for Tahap 4: supabase/migrations/20261030000100_close_public_access.sql
-- Restores the pre-Tahap-4 state: the 14 "public can ..." policies (identical to
-- supabase/schema.sql), full table privileges for anon and authenticated, realtime
-- publication of students/attendances/holidays, the old capture_sync_change (full
-- row copy), the old get_monthly_class_prayer_ranking (callable by anon), and the
-- column name students.password. Tahap 1 objects are left in place.
--
-- NOT restored:
--   - sync_changes rows that contained a password were deleted by the migration and
--     cannot be recovered.
--   - sync_changes rows written while Tahap 4 was active carry only id, nis, name,
--     class_name, gender, username, is_active (no password). Old-app clients that
--     apply such a row may need a full page reload before that student can log in.
--
-- Paste the whole file into the Supabase SQL Editor; it runs in one transaction.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.students'::regclass
      and attname = 'password_legacy'
      and not attisdropped
  ) then
    raise exception 'Kolom students.password_legacy tidak ditemukan. Migrasi Tahap 4 belum diterapkan atau sudah di-rollback.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Column name
-- ---------------------------------------------------------------------------
alter table public.students rename column password_legacy to password;

-- ---------------------------------------------------------------------------
-- Old sync trigger function (full row copy), as in supabase/schema.sql.
-- ---------------------------------------------------------------------------
create or replace function public.capture_sync_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  payload_id text;
  payload_date date;
  payload_student_id text;
begin
  if tg_op = 'DELETE' then
    payload := to_jsonb(old);
  else
    payload := to_jsonb(new);
  end if;

  payload_id := coalesce(payload ->> 'id', payload ->> 'date');
  if tg_table_name = 'attendances' then
    payload_date := (payload ->> 'date')::date;
    payload_student_id := payload ->> 'student_id';
  elsif tg_table_name = 'holidays' then
    payload_date := (payload ->> 'date')::date;
  elsif tg_table_name = 'students' then
    payload_student_id := payload ->> 'id';
  end if;

  insert into public.sync_changes (
    table_name,
    operation,
    record_id,
    record_date,
    student_id,
    row_data
  ) values (
    tg_table_name,
    tg_op,
    payload_id,
    payload_date,
    payload_student_id,
    payload
  );

  delete from public.sync_changes
  where changed_at < now() - interval '30 days';

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.capture_sync_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Old monthly ranking (anyone, all students), as in supabase/schema.sql.
-- ---------------------------------------------------------------------------
create or replace function public.get_monthly_class_prayer_ranking(
  p_month date,
  p_class_name text default null
)
returns table (
  class_name text,
  student_count bigint,
  sholat_count bigint,
  haid_count bigint,
  absent_count bigint,
  expected_attendance bigint,
  percentage numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with bounds as (
    select
      date_trunc('month', p_month)::date as start_date,
      (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_date
  ), month_days as (
    select (end_date - start_date + 1)::bigint as days
    from bounds
  ), class_students as (
    select
      s.class_name,
      count(*)::bigint as student_count
    from public.students s
    where p_class_name is null or s.class_name = p_class_name
    group by s.class_name
  ), class_attendances as (
    select
      a.class_name,
      count(a.id) filter (where a.status <> 'Haid')::bigint as sholat_count,
      count(a.id) filter (where a.status = 'Haid')::bigint as haid_count,
      count(a.id)::bigint as attendance_count
    from public.attendances a
    cross join bounds b
    where a.date >= b.start_date
      and a.date <= b.end_date
      and (p_class_name is null or a.class_name = p_class_name)
    group by a.class_name
  )
  select
    cs.class_name,
    cs.student_count,
    coalesce(ca.sholat_count, 0) as sholat_count,
    coalesce(ca.haid_count, 0) as haid_count,
    greatest((cs.student_count * md.days) - coalesce(ca.attendance_count, 0), 0) as absent_count,
    cs.student_count * md.days as expected_attendance,
    round(
      case
        when cs.student_count * md.days = 0 then 0
        else coalesce(ca.sholat_count, 0)::numeric * 100 / (cs.student_count * md.days)
      end,
      1
    ) as percentage
  from class_students cs
  cross join month_days md
  left join class_attendances ca on ca.class_name = cs.class_name
  order by percentage desc, sholat_count desc, cs.class_name asc;
$$;

revoke execute on function public.get_monthly_class_prayer_ranking(date, text) from public;
grant execute on function public.get_monthly_class_prayer_ranking(date, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['students', 'attendances', 'holidays'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Table privileges: full privileges for anon and authenticated (production audit).
-- Revoking first also clears the column-level grants on students.
-- ---------------------------------------------------------------------------
revoke all on table
  public.students, public.attendances, public.holidays, public.prayer_schedule, public.sync_changes
  from anon, authenticated;
grant all on table
  public.students, public.attendances, public.holidays, public.prayer_schedule, public.sync_changes
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The 14 old policies, identical to supabase/schema.sql.
-- ---------------------------------------------------------------------------
drop policy if exists "public can read students" on public.students;
drop policy if exists "public can insert students" on public.students;
drop policy if exists "public can update students" on public.students;
drop policy if exists "public can delete students" on public.students;
drop policy if exists "public can read attendances" on public.attendances;
drop policy if exists "public can insert attendances" on public.attendances;
drop policy if exists "public can update attendances" on public.attendances;
drop policy if exists "public can delete attendances" on public.attendances;
drop policy if exists "public can read holidays" on public.holidays;
drop policy if exists "public can insert holidays" on public.holidays;
drop policy if exists "public can delete holidays" on public.holidays;
drop policy if exists "public can read prayer schedule" on public.prayer_schedule;
drop policy if exists "public can update prayer schedule" on public.prayer_schedule;
drop policy if exists "public can read sync changes" on public.sync_changes;
create policy "public can read students" on public.students for select using (true);
create policy "public can insert students" on public.students for insert with check (true);
create policy "public can update students" on public.students for update using (true) with check (true);
create policy "public can delete students" on public.students for delete using (true);
create policy "public can read attendances" on public.attendances for select using (true);
create policy "public can insert attendances" on public.attendances for insert with check (true);
create policy "public can update attendances" on public.attendances for update using (true) with check (true);
create policy "public can delete attendances" on public.attendances for delete using (true);
create policy "public can read holidays" on public.holidays for select using (true);
create policy "public can insert holidays" on public.holidays for insert with check (true);
create policy "public can delete holidays" on public.holidays for delete using (true);
create policy "public can read prayer schedule" on public.prayer_schedule for select using (true);
create policy "public can update prayer schedule" on public.prayer_schedule for update using (true) with check (true);
create policy "public can read sync changes" on public.sync_changes for select using (true);

notify pgrst, 'reload schema';

commit;
