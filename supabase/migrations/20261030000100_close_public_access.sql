-- Tahap 4: close public access.
-- Spec: docs/superpowers/specs/2026-10-30-supabase-auth-security-design.md (sections 9, 11).
-- Rollback: supabase/rollback/20261030000100_close_public_access.sql
-- Test: supabase/tests/access.sql
--
-- Run only after the new app (Supabase Auth + RPCs) has been live and stable for at
-- least 3 school days. After this, the old app can no longer read or write anything.
-- Requires Tahap 1 (supabase/migrations/20261030000000_auth_foundation.sql).
--
-- Paste the whole file into the Supabase SQL Editor; it runs in one transaction, so
-- any failure leaves the database unchanged. It takes exclusive locks on the app
-- tables while the app is live; lock_timeout makes it fail fast instead of queueing
-- behind long requests.
--
-- Waktu menjalankan: di luar jendela dzuhur (jangan antara 11:00-15:30 WIB), saat murid
-- tidak sedang absen. Jika gagal dengan "canceling statement due to lock timeout" atau
-- "deadlock detected", tidak ada yang berubah (satu transaksi): cukup jalankan ulang
-- file ini beberapa saat kemudian.
--
-- Not reversible by the rollback: sync_changes rows that contain a password are
-- deleted here.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regprocedure('public.is_admin()') is null
     or pg_catalog.to_regprocedure('public.current_student_id()') is null then
    raise exception 'Migrasi Tahap 1 (auth_foundation) belum diterapkan.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.students'::regclass
      and attname = 'password'
      and not attisdropped
  ) then
    raise exception 'Kolom students.password tidak ditemukan. Migrasi ini mungkin sudah diterapkan.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Drop the old "public can ..." policies (14).
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

-- ---------------------------------------------------------------------------
-- Table privileges: anon gets nothing, authenticated may only select.
-- ---------------------------------------------------------------------------
revoke all on table
  public.students, public.attendances, public.holidays, public.prayer_schedule, public.sync_changes
  from anon;

-- PUBLIC (every role) gets nothing either; Supabase normally grants it nothing here,
-- this makes sure of it.
revoke all on table
  public.students, public.attendances, public.holidays, public.prayer_schedule, public.sync_changes
  from public;

-- sync_changes ids are only drawn by the security definer trigger (as the owner);
-- API roles never need the sequence.
revoke all on sequence public.sync_changes_id_seq from anon, authenticated;

revoke insert, update, delete, truncate, references, trigger on table
  public.students, public.attendances, public.holidays, public.prayer_schedule, public.sync_changes
  from authenticated;

-- MAINTAIN (PostgreSQL 17+) is part of the default Supabase grant too.
do $$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on table public.students, public.attendances, public.holidays, '
         || 'public.prayer_schedule, public.sync_changes from authenticated';
  end if;
end $$;

-- students: column grant without the credential column. auth_user_id (a UUID, not a
-- credential) is included because the app looks up the own profile with
-- .eq("auth_user_id", uid), and a filter needs select on the column.
revoke select on table public.students from authenticated;
grant select (id, nis, name, class_name, gender, username, is_active, created_at, auth_user_id)
  on table public.students to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: only sync_changes (admin, via RLS) and prayer_schedule remain.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['students', 'attendances', 'holidays'] loop
    if exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Sync trigger: student rows carry only non-credential columns.
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

  if tg_table_name = 'students' then
    payload := jsonb_build_object(
      'id', payload -> 'id',
      'nis', payload -> 'nis',
      'name', payload -> 'name',
      'class_name', payload -> 'class_name',
      'gender', payload -> 'gender',
      'username', payload -> 'username',
      'is_active', payload -> 'is_active'
    );
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

delete from public.sync_changes
where row_data ? 'password' or row_data ? 'password_legacy';

-- ---------------------------------------------------------------------------
-- Legacy credential column: renamed, no access for API roles. Dropped in Tahap 5.
-- ---------------------------------------------------------------------------
alter table public.students rename column password to password_legacy;
revoke all (password_legacy) on table public.students from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Monthly ranking: admin only, active students only.
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
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'Hanya guru yang dapat melakukan aksi ini.';
  end if;

  return query
  with bounds as (
    select
      date_trunc('month', p_month)::date as start_date,
      (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_date
  ), month_days as (
    select (b.end_date - b.start_date + 1)::bigint as days
    from bounds b
  ), class_students as (
    select
      s.class_name,
      count(*)::bigint as student_count
    from public.students s
    where s.is_active
      and (p_class_name is null or s.class_name = p_class_name)
    group by s.class_name
  ), class_attendances as (
    select
      a.class_name,
      count(a.id) filter (where a.status <> 'Haid')::bigint as sholat_count,
      count(a.id) filter (where a.status = 'Haid')::bigint as haid_count,
      count(a.id)::bigint as attendance_count
    from public.attendances a
    join public.students s on s.id = a.student_id and s.is_active
    cross join bounds b
    where a.date >= b.start_date
      and a.date <= b.end_date
      and (p_class_name is null or a.class_name = p_class_name)
    group by a.class_name
  ), ranked as (
    select
      cs.class_name,
      cs.student_count,
      coalesce(ca.sholat_count, 0)::bigint as sholat_count,
      coalesce(ca.haid_count, 0)::bigint as haid_count,
      greatest((cs.student_count * md.days) - coalesce(ca.attendance_count, 0), 0)::bigint as absent_count,
      (cs.student_count * md.days)::bigint as expected_attendance,
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
  )
  select r.class_name, r.student_count, r.sholat_count, r.haid_count,
         r.absent_count, r.expected_attendance, r.percentage
  from ranked r
  order by r.percentage desc, r.sholat_count desc, r.class_name asc;
end;
$$;

revoke execute on function public.get_monthly_class_prayer_ranking(date, text) from public, anon;
grant execute on function public.get_monthly_class_prayer_ranking(date, text) to authenticated;

notify pgrst, 'reload schema';

commit;
