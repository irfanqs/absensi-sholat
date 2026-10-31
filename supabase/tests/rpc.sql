-- RPC tests for the Tahap 1 auth foundation migration.
-- Run against STAGING only, from the repo root:
--   scripts/staging.sh psql -f supabase/tests/rpc.sql
-- Everything runs in one transaction that is rolled back at the end.
-- Prints "rpc.sql: ALL PASSED" when every case passes; stops at the first failure.
-- Window tests are skipped (with a notice) when the Jakarta hour is 23 or 00,
-- because "now +/- 1 hour" would wrap around midnight.
-- Student fixtures list only the columns they need; the legacy credential column
-- keeps its default and is never named, so this file survives its later rename.

\set ON_ERROR_STOP 1
\pset tuples_only on
\set claims_p '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"role":"student"}}'
\set claims_l '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","app_metadata":{"role":"student"}}'
\set claims_x '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","app_metadata":{"role":"student"}}'
\set claims_admin '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"role":"admin"}}'

begin;

-- Preflight: every function under test must exist.
select 'public.submit_attendance(text)'::regprocedure,
       'public.is_admin()'::regprocedure,
       'public.current_student_id()'::regprocedure,
       'public.submit_late_attendance(date, text)'::regprocedure,
       'public.admin_mark_attendance(text, date, text)'::regprocedure,
       'public.admin_delete_attendance(text)'::regprocedure,
       'public.admin_set_holiday(date, boolean)'::regprocedure,
       'public.admin_set_prayer_schedule(boolean, time, time, date)'::regprocedure;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
select set_config(
  'test.skip_window',
  case when extract(hour from now() at time zone 'Asia/Jakarta') in (23, 0) then 'on' else 'off' end,
  true
);

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rpctest-p@absensi-sholat.local'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rpctest-l@absensi-sholat.local'),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rpctest-x@absensi-sholat.local'),
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rpctest-guru@absensi-sholat.local');

insert into public.students (id, name, class_name, gender, username, auth_user_id, is_active) values
  ('rpctest-p', 'RPC Test Putri', 'RPCTEST', 'Perempuan', 'rpctest_p', '11111111-1111-4111-8111-111111111111', true),
  ('rpctest-l', 'RPC Test Putra', 'RPCTEST', 'Laki-laki', 'rpctest_l', '22222222-2222-4222-8222-222222222222', true),
  ('rpctest-x', 'RPC Test Nonaktif', 'RPCTEST', 'Perempuan', 'rpctest_x', '33333333-3333-4333-8333-333333333333', false);

-- Known baseline: no holidays near today, schedule disabled, default start date.
delete from public.holidays
where date between (now() at time zone 'Asia/Jakarta')::date - 5
               and (now() at time zone 'Asia/Jakarta')::date + 5;
update public.prayer_schedule
set enabled = false, start_time = '11:30', end_time = '15:00', attendance_start_date = '2026-08-01'
where id = 1;

-- ---------------------------------------------------------------------------
-- rpc_execute_grants (as postgres): authenticated may execute, anon may not.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.is_admin()',
    'public.current_student_id()',
    'public.submit_attendance(text)',
    'public.submit_late_attendance(date, text)',
    'public.admin_mark_attendance(text, date, text)',
    'public.admin_delete_attendance(text)',
    'public.admin_set_holiday(date, boolean)',
    'public.admin_set_prayer_schedule(boolean, time, time, date)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'rpc_execute_grants: anon can execute %', fn;
    end if;
    if not has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'rpc_execute_grants: authenticated cannot execute %', fn;
    end if;
    if not (select p.prosecdef and p.proconfig @> array['search_path=""']
            from pg_proc p where p.oid = fn::regprocedure) then
      raise exception 'rpc_execute_grants: % must be security definer with empty search_path', fn;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- inactive_student_rejected (inactive student)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_x', true);
do $$ begin
  perform public.submit_attendance('Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Akun siswa tidak ditemukan atau nonaktif.' then
    raise exception 'inactive_student_rejected: got "%"', sqlerrm;
  end if;
end $$;
do $$ begin
  if public.current_student_id() is not null then
    raise exception 'inactive_student_rejected: current_student_id() should be null';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- invalid_status_rejected (female student)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_p', true);
do $$ begin
  if public.current_student_id() is distinct from 'rpctest-p' then
    raise exception 'current_student_id: expected rpctest-p, got %', public.current_student_id();
  end if;
  if public.is_admin() then
    raise exception 'is_admin: student claims must not be admin';
  end if;
end $$;
do $$ begin
  perform public.submit_attendance('Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Status absensi tidak valid.' then
    raise exception 'invalid_status_rejected: got "%"', sqlerrm;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- haid_male_rejected (male student)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$ begin
  perform public.submit_attendance('Haid');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Status Haid hanya untuk siswa perempuan.' then
    raise exception 'haid_male_rejected: got "%"', sqlerrm;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- holiday_rejected (male student): today is a holiday.
-- ---------------------------------------------------------------------------
insert into public.holidays (date) values ((now() at time zone 'Asia/Jakarta')::date);
set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$ begin
  perform public.submit_attendance('Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.' then
    raise exception 'holiday_rejected: got "%"', sqlerrm;
  end if;
end $$;
reset role;
delete from public.holidays where date = (now() at time zone 'Asia/Jakarta')::date;

-- ---------------------------------------------------------------------------
-- Window: submit_hadir_inside_window, returned_row_uses_server_date,
-- submit_twice_returns_same_row (female student). Window = now +/- 1 hour.
-- ---------------------------------------------------------------------------
do $$ begin
  if current_setting('test.skip_window') = 'on' then
    raise notice 'rpc.sql: SKIP window tests (Jakarta hour is 23 or 00)';
    return;
  end if;
  update public.prayer_schedule
  set enabled = true,
      start_time = ((now() at time zone 'Asia/Jakarta') - interval '1 hour')::time,
      end_time = ((now() at time zone 'Asia/Jakarta') + interval '1 hour')::time
  where id = 1;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_p', true);
do $$
declare
  r public.attendances;
  r2 public.attendances;
begin
  if current_setting('test.skip_window') = 'on' then return; end if;

  -- submit_hadir_inside_window
  select * into r from public.submit_attendance('Hadir');
  if r.id is null or r.status <> 'Hadir'
     or r.recorded_by is distinct from '11111111-1111-4111-8111-111111111111'::uuid then
    raise exception 'submit_hadir_inside_window: %', row_to_json(r);
  end if;

  -- returned_row_uses_server_date
  if r.date <> (now() at time zone 'Asia/Jakarta')::date
     or r.time !~ '^\d{2}\.\d{2}$'
     or r.time <> to_char(now() at time zone 'Asia/Jakarta', 'HH24.MI')
     or r.student_id <> 'rpctest-p'
     or r.student_name <> 'RPC Test Putri'
     or r.class_name <> 'RPCTEST' then
    raise exception 'returned_row_uses_server_date: %', row_to_json(r);
  end if;

  -- submit_twice_returns_same_row
  select * into r2 from public.submit_attendance('Hadir');
  if r2.id is distinct from r.id then
    raise exception 'submit_twice_returns_same_row: % vs %', r.id, r2.id;
  end if;

  perform set_config('test.p_row_id', r.id, true);
end $$;
reset role;

do $$ begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  if (select count(*) from public.attendances
      where student_id = 'rpctest-p' and date = (now() at time zone 'Asia/Jakarta')::date) <> 1 then
    raise exception 'submit_twice_returns_same_row: expected exactly one row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- before_window_rejected (male student): start = now + 1 hour.
-- ---------------------------------------------------------------------------
do $$ begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  update public.prayer_schedule
  set enabled = true,
      start_time = date_trunc('minute', (now() at time zone 'Asia/Jakarta') + interval '1 hour')::time,
      end_time = '23:59:59'
  where id = 1;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$
declare
  expected text := 'Konfirmasi sholat Dzuhur tersedia mulai pukul '
    || to_char((now() at time zone 'Asia/Jakarta') + interval '1 hour', 'HH24.MI') || ' WIB.';
begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  begin
    perform public.submit_attendance('Hadir');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm is distinct from expected then
      raise exception 'before_window_rejected: expected "%", got "%"', expected, sqlerrm;
    end if;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- after_window_rejected (male student): end = now - 1 hour.
-- repeat_after_window_returns_existing (female student, already recorded today).
-- ---------------------------------------------------------------------------
do $$ begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  update public.prayer_schedule
  set enabled = true,
      start_time = '00:00',
      end_time = ((now() at time zone 'Asia/Jakarta') - interval '1 hour')::time
  where id = 1;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$
declare
  expected text := 'Waktu konfirmasi berakhir pukul '
    || to_char((now() at time zone 'Asia/Jakarta') - interval '1 hour', 'HH24.MI')
    || ' WIB. Harap konfirmasi ke guru bila terjadi kesalahan.';
begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  begin
    perform public.submit_attendance('Hadir');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm is distinct from expected then
      raise exception 'after_window_rejected: expected "%", got "%"', expected, sqlerrm;
    end if;
  end;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_p', true);
do $$
declare
  r public.attendances;
begin
  if current_setting('test.skip_window') = 'on' then return; end if;
  select * into r from public.submit_attendance('Hadir');
  if r.id is distinct from current_setting('test.p_row_id') then
    raise exception 'repeat_after_window_returns_existing: expected %, got %',
      current_setting('test.p_row_id'), row_to_json(r);
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- disabled_schedule_allows_any_time (male student): window already passed.
-- ---------------------------------------------------------------------------
update public.prayer_schedule
set enabled = false, start_time = '00:00', end_time = '00:01'
where id = 1;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$
declare
  r public.attendances;
begin
  select * into r from public.submit_attendance('Hadir');
  if r.id is null or r.status <> 'Hadir' or r.student_id <> 'rpctest-l'
     or r.date <> (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'disabled_schedule_allows_any_time: %', row_to_json(r);
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Late corrections (male student).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);

-- late_ok
do $$
declare
  r public.attendances;
  v_yesterday date := (now() at time zone 'Asia/Jakarta')::date - 1;
begin
  select * into r from public.submit_late_attendance(v_yesterday, 'Terlambat');
  if r.id is null or r.status <> 'Terlambat' or r.date <> v_yesterday
     or r.student_id <> 'rpctest-l'
     or r.recorded_by is distinct from '22222222-2222-4222-8222-222222222222'::uuid then
    raise exception 'late_ok: %', row_to_json(r);
  end if;
end $$;

-- late_before_start_rejected
do $$ begin
  perform public.submit_late_attendance('2026-07-31', 'Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Tanggal koreksi di luar rentang yang diizinkan.' then
    raise exception 'late_before_start_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- late_today_and_future_rejected (today)
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date, 'Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Tanggal koreksi di luar rentang yang diizinkan.' then
    raise exception 'late_today_and_future_rejected (today): got "%"', sqlerrm;
  end if;
end $$;

-- late_today_and_future_rejected (tomorrow)
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date + 1, 'Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Tanggal koreksi di luar rentang yang diizinkan.' then
    raise exception 'late_today_and_future_rejected (tomorrow): got "%"', sqlerrm;
  end if;
end $$;

-- late_existing_rejected
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date - 1, 'Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Absensi tanggal tersebut sudah tercatat.' then
    raise exception 'late_existing_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- late_invalid_status_rejected (Hadir is not a late status)
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date - 3, 'Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Status absensi tidak valid.' then
    raise exception 'late_invalid_status_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- late_haid_male_rejected
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date - 3, 'Haid');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Status Haid hanya untuk siswa perempuan.' then
    raise exception 'late_haid_male_rejected: got "%"', sqlerrm;
  end if;
end $$;
reset role;

-- late_holiday_rejected: the day before yesterday becomes a holiday.
insert into public.holidays (date) values ((now() at time zone 'Asia/Jakarta')::date - 2);
set local role authenticated;
select set_config('request.jwt.claims', :'claims_l', true);
do $$ begin
  perform public.submit_late_attendance((now() at time zone 'Asia/Jakarta')::date - 2, 'Terlambat');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.' then
    raise exception 'late_holiday_rejected: got "%"', sqlerrm;
  end if;
end $$;
reset role;
delete from public.holidays where date = (now() at time zone 'Asia/Jakarta')::date - 2;

-- ---------------------------------------------------------------------------
-- admin_rpcs_reject_student (female student)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_p', true);
do $$ begin
  perform public.admin_mark_attendance('rpctest-l', (now() at time zone 'Asia/Jakarta')::date, 'Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Hanya guru yang dapat melakukan aksi ini.' then
    raise exception 'admin_rpcs_reject_student (mark): got "%"', sqlerrm;
  end if;
end $$;
do $$ begin
  perform public.admin_delete_attendance('does-not-matter');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Hanya guru yang dapat melakukan aksi ini.' then
    raise exception 'admin_rpcs_reject_student (delete): got "%"', sqlerrm;
  end if;
end $$;
do $$ begin
  perform public.admin_set_holiday((now() at time zone 'Asia/Jakarta')::date, true);
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Hanya guru yang dapat melakukan aksi ini.' then
    raise exception 'admin_rpcs_reject_student (holiday): got "%"', sqlerrm;
  end if;
end $$;
do $$ begin
  perform public.admin_set_prayer_schedule(true, '11:00', '14:00', '2026-08-01');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Hanya guru yang dapat melakukan aksi ini.' then
    raise exception 'admin_rpcs_reject_student (schedule): got "%"', sqlerrm;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Admin cases
-- ---------------------------------------------------------------------------
-- Clear the male student's row for today so admin_mark_and_delete inserts a fresh one.
delete from public.attendances
where student_id = 'rpctest-l' and date = (now() at time zone 'Asia/Jakarta')::date;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);

do $$ begin
  if not public.is_admin() then
    raise exception 'is_admin: admin claims should be admin';
  end if;
  if public.current_student_id() is not null then
    raise exception 'current_student_id: admin has no student row';
  end if;
end $$;

-- admin_mark_future_rejected
do $$ begin
  perform public.admin_mark_attendance('rpctest-l', (now() at time zone 'Asia/Jakarta')::date + 1, 'Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Absensi untuk tanggal mendatang belum tersedia.' then
    raise exception 'admin_mark_future_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- admin_mark_haid_male_rejected
do $$ begin
  perform public.admin_mark_attendance('rpctest-l', (now() at time zone 'Asia/Jakarta')::date, 'Haid');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Status Haid hanya untuk siswa perempuan.' then
    raise exception 'admin_mark_haid_male_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- admin_mark_inactive_rejected
do $$ begin
  perform public.admin_mark_attendance('rpctest-x', (now() at time zone 'Asia/Jakarta')::date, 'Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm is distinct from 'Akun siswa tidak ditemukan atau nonaktif.' then
    raise exception 'admin_mark_inactive_rejected: got "%"', sqlerrm;
  end if;
end $$;

-- admin_mark_and_delete (mark)
do $$
declare
  r public.attendances;
begin
  select * into r from public.admin_mark_attendance('rpctest-l', (now() at time zone 'Asia/Jakarta')::date, 'Hadir');
  if r.id is null or r.status <> 'Hadir' or r.student_id <> 'rpctest-l'
     or r.student_name <> 'RPC Test Putra'
     or r.recorded_by is distinct from '44444444-4444-4444-8444-444444444444'::uuid then
    raise exception 'admin_mark_and_delete (mark): %', row_to_json(r);
  end if;
  perform set_config('test.admin_row_id', r.id, true);
end $$;
reset role;

do $$ begin
  if not exists (select 1 from public.attendances where id = current_setting('test.admin_row_id')) then
    raise exception 'admin_mark_and_delete: marked row missing';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);
do $$ begin
  perform public.admin_delete_attendance(current_setting('test.admin_row_id'));
end $$;
reset role;

do $$ begin
  if exists (select 1 from public.attendances where id = current_setting('test.admin_row_id')) then
    raise exception 'admin_mark_and_delete: row still present after delete';
  end if;
end $$;

-- admin_set_holiday_toggle
set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);
do $$ begin
  perform public.admin_set_holiday((now() at time zone 'Asia/Jakarta')::date + 1, true);
  perform public.admin_set_holiday((now() at time zone 'Asia/Jakarta')::date + 1, true); -- idempotent
end $$;
reset role;
do $$ begin
  if (select count(*) from public.holidays where date = (now() at time zone 'Asia/Jakarta')::date + 1) <> 1 then
    raise exception 'admin_set_holiday_toggle: holiday row missing after true';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);
do $$ begin
  perform public.admin_set_holiday((now() at time zone 'Asia/Jakarta')::date + 1, false);
end $$;
reset role;
do $$ begin
  if exists (select 1 from public.holidays where date = (now() at time zone 'Asia/Jakarta')::date + 1) then
    raise exception 'admin_set_holiday_toggle: holiday row still present after false';
  end if;
end $$;

-- admin_set_schedule
set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);
do $$
declare
  r public.prayer_schedule;
begin
  select * into r from public.admin_set_prayer_schedule(true, '11:00', '14:00', '2026-08-01');
  if r.id <> 1 or not r.enabled or r.start_time <> '11:00' or r.end_time <> '14:00'
     or r.attendance_start_date <> '2026-08-01' then
    raise exception 'admin_set_schedule (returned): %', row_to_json(r);
  end if;
end $$;
reset role;
do $$ begin
  if not exists (
    select 1 from public.prayer_schedule
    where id = 1 and enabled and start_time = '11:00' and end_time = '14:00'
      and attendance_start_date = '2026-08-01'
  ) then
    raise exception 'admin_set_schedule: stored row does not match';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Constraints (as postgres)
-- ---------------------------------------------------------------------------
-- status_check_constraint
do $$ begin
  insert into public.attendances (id, student_id, student_name, class_name, date, time, status)
  values ('rpctest-izin', 'rpctest-l', 'RPC Test Putra', 'RPCTEST',
          (now() at time zone 'Asia/Jakarta')::date - 4, '11.00', 'Izin');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm not like '%attendances_status_check%' then
    raise exception 'status_check_constraint: got "%"', sqlerrm;
  end if;
end $$;

-- delete_student_with_history_restricted (male student has the late_ok row)
do $$ begin
  delete from public.students where id = 'rpctest-l';
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlstate <> '23503' or sqlerrm not like '%attendances_student_id_fkey%' then
    raise exception 'delete_student_with_history_restricted: got % "%"', sqlstate, sqlerrm;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- anon_cannot_call_rpc
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ begin
  perform public.submit_attendance('Hadir');
  raise exception 'EXPECTED FAILURE';
exception when insufficient_privilege then
  null;
end $$;
reset role;

do $$ begin raise notice 'rpc.sql: ALL PASSED'; end $$;

rollback;
