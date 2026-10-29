-- Access tests for the Tahap 4 migration (close public access).
-- Run against STAGING only, after supabase/migrations/20261030000100_close_public_access.sql:
--   scripts/staging.sh psql -f supabase/tests/access.sql
-- Everything runs in one transaction that is rolled back at the end.
-- Prints "access.sql: ALL PASSED" when every case passes; stops at the first failure.

\set ON_ERROR_STOP 1
\pset tuples_only on
\set claims_p '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{"role":"student"}}'
\set claims_admin '{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"role":"admin"}}'

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): class ACCTEST with two active students (P, L) and
-- one inactive student (X), each with attendance in October 2026.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email) values
  ('55555555-5555-4555-8555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'acctest-p@absensi-sholat.local'),
  ('66666666-6666-4666-8666-666666666666', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'acctest-l@absensi-sholat.local'),
  ('77777777-7777-4777-8777-777777777777', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'acctest-x@absensi-sholat.local'),
  ('88888888-8888-4888-8888-888888888888', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'acctest-guru@absensi-sholat.local');

insert into public.students (id, name, class_name, gender, username, auth_user_id, is_active) values
  ('acctest-p', 'Access Test Putri', 'ACCTEST', 'Perempuan', 'acctest_p', '55555555-5555-4555-8555-555555555555', true),
  ('acctest-l', 'Access Test Putra', 'ACCTEST', 'Laki-laki', 'acctest_l', '66666666-6666-4666-8666-666666666666', true),
  ('acctest-x', 'Access Test Nonaktif', 'ACCTEST', 'Perempuan', 'acctest_x', '77777777-7777-4777-8777-777777777777', false);

insert into public.attendances (id, student_id, student_name, class_name, date, time, status) values
  ('acctest-p-1', 'acctest-p', 'Access Test Putri', 'ACCTEST', '2026-10-05', '12.00', 'Hadir'),
  ('acctest-p-2', 'acctest-p', 'Access Test Putri', 'ACCTEST', '2026-10-06', '12.00', 'Hadir'),
  ('acctest-l-1', 'acctest-l', 'Access Test Putra', 'ACCTEST', '2026-10-05', '12.00', 'Hadir'),
  ('acctest-x-1', 'acctest-x', 'Access Test Nonaktif', 'ACCTEST', '2026-10-05', '12.00', 'Hadir');

-- Baseline counts as postgres, for admin_reads_everything.
select set_config('test.n_students', (select count(*) from public.students)::text, true);
select set_config('test.n_attendances', (select count(*) from public.attendances)::text, true);
select set_config('test.n_sync_changes', (select count(*) from public.sync_changes)::text, true);

-- ---------------------------------------------------------------------------
-- anon_cannot_select_any_table, anon_cannot_write, anon_cannot_rank
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare
  t text;
begin
  -- anon_cannot_select_any_table
  foreach t in array array['students', 'attendances', 'holidays', 'prayer_schedule', 'sync_changes'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'EXPECTED FAILURE';
    exception when others then
      if sqlerrm not like 'permission denied%' then
        raise exception 'anon_cannot_select_any_table (%): got "%"', t, sqlerrm;
      end if;
    end;
  end loop;

  -- anon_cannot_write
  begin
    insert into public.holidays (date) values ('1900-01-01');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'anon_cannot_write (insert holidays): got "%"', sqlerrm;
    end if;
  end;
  begin
    update public.prayer_schedule set enabled = enabled where id = 1;
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'anon_cannot_write (update prayer_schedule): got "%"', sqlerrm;
    end if;
  end;
  begin
    delete from public.attendances where id = 'acctest-p-1';
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'anon_cannot_write (delete attendances): got "%"', sqlerrm;
    end if;
  end;

  -- anon_cannot_rank
  begin
    perform * from public.get_monthly_class_prayer_ranking('2026-10-01');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'anon_cannot_rank: got "%"', sqlerrm;
    end if;
  end;

  -- get_server_time() stays callable by anon (spec section 9).
  perform public.get_server_time();
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Student P: student_sees_only_self, student_profile_lookup_by_auth_user_id,
-- student_cannot_read_password_legacy, student_cannot_write_directly,
-- student_cannot_read_sync_changes, student_cannot_rank
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_p', true);
do $$
declare
  n bigint;
  v_id text;
begin
  -- student_sees_only_self
  select count(*) into n from public.students;
  if n <> 1 then
    raise exception 'student_sees_only_self (students): expected 1, got %', n;
  end if;
  select count(*) into n from public.attendances;
  if n <> 2 then
    raise exception 'student_sees_only_self (attendances): expected 2, got %', n;
  end if;
  select count(*) into n from public.attendances where student_id <> 'acctest-p';
  if n <> 0 then
    raise exception 'student_sees_only_self (attendances): sees % rows of other students', n;
  end if;

  -- student_profile_lookup_by_auth_user_id: the app filters on auth_user_id.
  select s.id into v_id from public.students s where s.auth_user_id = auth.uid();
  if v_id is distinct from 'acctest-p' then
    raise exception 'student_profile_lookup_by_auth_user_id: expected acctest-p, got %', v_id;
  end if;

  -- student_cannot_read_password_legacy
  begin
    perform password_legacy from public.students;
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'student_cannot_read_password_legacy: got "%"', sqlerrm;
    end if;
  end;

  -- student_cannot_write_directly
  begin
    insert into public.attendances (id, student_id, student_name, class_name, date, time, status)
    values ('acctest-direct', 'acctest-p', 'Access Test Putri', 'ACCTEST', '2026-10-07', '12.00', 'Hadir');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'student_cannot_write_directly (insert attendances): got "%"', sqlerrm;
    end if;
  end;
  begin
    update public.students set name = 'Diubah Siswa' where id = 'acctest-p';
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'student_cannot_write_directly (update students): got "%"', sqlerrm;
    end if;
  end;
  begin
    insert into public.holidays (date) values ('1900-01-01');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm not like 'permission denied%' then
      raise exception 'student_cannot_write_directly (insert holidays): got "%"', sqlerrm;
    end if;
  end;

  -- student_cannot_read_sync_changes
  select count(*) into n from public.sync_changes;
  if n <> 0 then
    raise exception 'student_cannot_read_sync_changes: expected 0, got %', n;
  end if;

  -- student_cannot_rank
  begin
    perform * from public.get_monthly_class_prayer_ranking('2026-10-01');
    raise exception 'EXPECTED FAILURE';
  exception when others then
    if sqlerrm is distinct from 'Hanya guru yang dapat melakukan aksi ini.' then
      raise exception 'student_cannot_rank: got "%"', sqlerrm;
    end if;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Admin: admin_reads_everything, admin_lookup_by_auth_user_id,
-- ranking_counts_active_only
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'claims_admin', true);
do $$
declare
  n bigint;
  v_id text;
  r record;
begin
  -- admin_reads_everything
  select count(*) into n from public.students;
  if n <> current_setting('test.n_students')::bigint then
    raise exception 'admin_reads_everything (students): expected %, got %', current_setting('test.n_students'), n;
  end if;
  select count(*) into n from public.attendances;
  if n <> current_setting('test.n_attendances')::bigint then
    raise exception 'admin_reads_everything (attendances): expected %, got %', current_setting('test.n_attendances'), n;
  end if;
  select count(*) into n from public.sync_changes;
  if n <> current_setting('test.n_sync_changes')::bigint then
    raise exception 'admin_reads_everything (sync_changes): expected %, got %', current_setting('test.n_sync_changes'), n;
  end if;

  -- admin_lookup_by_auth_user_id
  select s.id into v_id from public.students s
  where s.auth_user_id = '66666666-6666-4666-8666-666666666666';
  if v_id is distinct from 'acctest-l' then
    raise exception 'admin_lookup_by_auth_user_id: expected acctest-l, got %', v_id;
  end if;

  -- ranking_counts_active_only: X (inactive) and its attendance are not counted.
  select * into r from public.get_monthly_class_prayer_ranking('2026-10-01', 'ACCTEST');
  if r.class_name is distinct from 'ACCTEST' or r.student_count <> 2 or r.sholat_count <> 3
     or r.expected_attendance <> 62 then
    raise exception 'ranking_counts_active_only: %', row_to_json(r);
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- sync_payload_has_no_password (postgres)
-- ---------------------------------------------------------------------------
update public.students set name = 'Access Test Putri Baru' where id = 'acctest-p';
do $$
declare
  v_row jsonb;
  v_keys text[];
begin
  select sc.row_data into v_row
  from public.sync_changes sc
  where sc.table_name = 'students' and sc.record_id = 'acctest-p'
  order by sc.id desc
  limit 1;
  if v_row is null or v_row ->> 'name' is distinct from 'Access Test Putri Baru' then
    raise exception 'sync_payload_has_no_password: latest row missing or stale: %', v_row;
  end if;
  if v_row ? 'password' or v_row ? 'password_legacy' then
    raise exception 'sync_payload_has_no_password: payload has a password key: %', v_row;
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(v_row) k;
  if v_keys is distinct from array['class_name', 'gender', 'id', 'is_active', 'name', 'nis', 'username'] then
    raise exception 'sync_payload_has_no_password: unexpected keys %', v_keys;
  end if;
  if exists (select 1 from public.sync_changes sc where sc.row_data ? 'password' or sc.row_data ? 'password_legacy') then
    raise exception 'sync_payload_has_no_password: old rows with a password key remain';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- realtime_publication_trimmed (postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  v_tables text[];
begin
  select array_agg(schemaname || '.' || tablename order by schemaname, tablename) into v_tables
  from pg_publication_tables
  where pubname = 'supabase_realtime';
  if v_tables is distinct from array['public.prayer_schedule', 'public.sync_changes'] then
    raise exception 'realtime_publication_trimmed: got %', v_tables;
  end if;
end $$;

do $$ begin raise notice 'access.sql: ALL PASSED'; end $$;

rollback;
