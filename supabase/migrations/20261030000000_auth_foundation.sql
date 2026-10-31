-- Tahap 1: auth foundation (additive).
-- Spec: docs/superpowers/specs/2026-10-30-supabase-auth-security-design.md (sections 7, 9, 11).
-- Rollback: supabase/rollback/20261030000000_auth_foundation.sql
--
-- Safe while the old app is live: the "public can ..." policies are not touched,
-- new columns are nullable or have defaults, and new policies only add access for
-- the authenticated role. Paste the whole file into the Supabase SQL Editor; it runs
-- in one transaction, so any failure leaves the database unchanged.
--
-- Read-only checks to run on production first (each must return 0 rows):
--   select status, count(*) from public.attendances
--   where status not in ('Hadir', 'Terlambat', 'Haid') group by status;
--   select lower(username), count(*) from public.students
--   group by lower(username) having count(*) > 1;
--
-- Waktu menjalankan: di luar jendela dzuhur (jangan antara 11:00-15:30 WIB). Migrasi ini
-- mengambil lock eksklusif pada tabel aplikasi; lock_timeout membuatnya gagal cepat
-- daripada mengantre di belakang request yang lama. Jika gagal dengan "canceling
-- statement due to lock timeout" atau "deadlock detected", tidak ada yang berubah (satu
-- transaksi): cukup jalankan ulang file ini beberapa saat kemudian.
--
-- Efek pada aplikasi LAMA selama Tahap 1-3 (diharapkan, bukan insiden):
--   - Username kini unik tanpa membedakan huruf besar/kecil (indeks lower(username)).
--     Menambah murid dengan username yang hanya beda huruf besar/kecil dari murid lain
--     (mis. 9A_Ahmad vs 9a_ahmad) gagal dengan error duplikat; impor Excel di aplikasi
--     lama melewati baris seperti itu tanpa pesan.
--   - Menghapus murid yang punya riwayat absensi kini gagal di database (foreign key
--     on delete restrict), bukan ikut menghapus riwayatnya. UI lama bisa tetap
--     menyembunyikan murid itu sampai halaman dimuat ulang, lalu murid muncul lagi.
--     Data aman; murid tersebut dinonaktifkan nanti lewat UI admin baru.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns, constraints, indexes
-- ---------------------------------------------------------------------------
alter table public.students
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null,
  add column if not exists is_active boolean not null default true;

create unique index if not exists students_username_lower_idx
  on public.students (lower(username));

alter table public.attendances
  add column if not exists recorded_by uuid;

alter table public.prayer_schedule
  add column if not exists attendance_start_date date not null default '2026-08-01';

alter table public.attendances drop constraint if exists attendances_status_check;
alter table public.attendances
  add constraint attendances_status_check
  check (status in ('Hadir', 'Terlambat', 'Haid')) not valid;
alter table public.attendances validate constraint attendances_status_check;

-- Replace the student foreign key: on delete cascade -> on delete restrict.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.attendances'::regclass
      and conname = 'attendances_student_id_fkey'
      and contype = 'f'
  ) then
    raise exception 'Foreign key attendances_student_id_fkey tidak ditemukan. Periksa nama constraint sebelum menjalankan migrasi.';
  end if;
  if (
    select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.attendances'::regclass
      and confrelid = 'public.students'::regclass
      and contype = 'f'
  ) <> 1 then
    raise exception 'Ditemukan lebih dari satu foreign key attendances -> students. Periksa sebelum menjalankan migrasi.';
  end if;
end $$;

alter table public.attendances
  drop constraint attendances_student_id_fkey,
  add constraint attendances_student_id_fkey
    foreign key (student_id) references public.students(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

create or replace function public.current_student_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.students s
  where s.auth_user_id = auth.uid()
    and s.is_active;
$$;

-- ---------------------------------------------------------------------------
-- Student RPCs
-- ---------------------------------------------------------------------------
create or replace function public.submit_attendance(p_status text)
returns public.attendances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'Asia/Jakarta';
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_now_minute integer;
  v_student_id text;
  v_name text;
  v_class_name text;
  v_gender text;
  v_schedule public.prayer_schedule;
  v_row public.attendances;
begin
  select s.id, s.name, s.class_name, s.gender
  into v_student_id, v_name, v_class_name, v_gender
  from public.students s
  where s.auth_user_id = auth.uid()
    and s.is_active;
  if v_student_id is null then
    raise exception 'Akun siswa tidak ditemukan atau nonaktif.';
  end if;

  if p_status is null or p_status not in ('Hadir', 'Haid') then
    raise exception 'Status absensi tidak valid.';
  end if;
  if p_status = 'Haid' and v_gender is distinct from 'Perempuan' then
    raise exception 'Status Haid hanya untuk siswa perempuan.';
  end if;

  -- Already recorded today: return it, even after the window has closed.
  select a.* into v_row
  from public.attendances a
  where a.student_id = v_student_id
    and a.date = v_today;
  if found then
    return v_row;
  end if;

  if exists (select 1 from public.holidays h where h.date = v_today) then
    raise exception 'Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.';
  end if;

  select ps.* into v_schedule
  from public.prayer_schedule ps
  where ps.id = 1;
  if found and v_schedule.enabled then
    -- Compare whole minutes, like the client.
    v_now_minute := extract(hour from v_now)::integer * 60 + extract(minute from v_now)::integer;
    if v_now_minute < extract(hour from v_schedule.start_time)::integer * 60
                      + extract(minute from v_schedule.start_time)::integer then
      raise exception 'Konfirmasi sholat Dzuhur tersedia mulai pukul % WIB.',
        to_char(v_schedule.start_time, 'HH24.MI');
    end if;
    if v_now_minute > extract(hour from v_schedule.end_time)::integer * 60
                      + extract(minute from v_schedule.end_time)::integer then
      raise exception 'Waktu konfirmasi berakhir pukul % WIB. Harap konfirmasi ke guru bila terjadi kesalahan.',
        to_char(v_schedule.end_time, 'HH24.MI');
    end if;
  end if;

  insert into public.attendances (
    id, student_id, student_name, class_name, date, time, status, recorded_by
  ) values (
    gen_random_uuid()::text, v_student_id, v_name, v_class_name, v_today,
    to_char(v_now, 'HH24.MI'), p_status, auth.uid()
  )
  on conflict (student_id, date) do nothing
  returning * into v_row;

  if not found then
    select a.* into v_row
    from public.attendances a
    where a.student_id = v_student_id
      and a.date = v_today;
  end if;

  return v_row;
end;
$$;

create or replace function public.submit_late_attendance(p_date date, p_status text)
returns public.attendances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'Asia/Jakarta';
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_start_date date;
  v_student_id text;
  v_name text;
  v_class_name text;
  v_gender text;
  v_row public.attendances;
begin
  select s.id, s.name, s.class_name, s.gender
  into v_student_id, v_name, v_class_name, v_gender
  from public.students s
  where s.auth_user_id = auth.uid()
    and s.is_active;
  if v_student_id is null then
    raise exception 'Akun siswa tidak ditemukan atau nonaktif.';
  end if;

  if p_status is null or p_status not in ('Terlambat', 'Haid') then
    raise exception 'Status absensi tidak valid.';
  end if;
  if p_status = 'Haid' and v_gender is distinct from 'Perempuan' then
    raise exception 'Status Haid hanya untuk siswa perempuan.';
  end if;

  select ps.attendance_start_date into v_start_date
  from public.prayer_schedule ps
  where ps.id = 1;
  v_start_date := coalesce(v_start_date, date '2026-08-01');

  if p_date is null or p_date < v_start_date or p_date >= v_today then
    raise exception 'Tanggal koreksi di luar rentang yang diizinkan.';
  end if;

  if exists (select 1 from public.holidays h where h.date = p_date) then
    raise exception 'Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.';
  end if;

  insert into public.attendances (
    id, student_id, student_name, class_name, date, time, status, recorded_by
  ) values (
    gen_random_uuid()::text, v_student_id, v_name, v_class_name, p_date,
    to_char(v_now, 'HH24.MI'), p_status, auth.uid()
  )
  on conflict (student_id, date) do nothing
  returning * into v_row;

  if not found then
    raise exception 'Absensi tanggal tersebut sudah tercatat.';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
create or replace function public.admin_mark_attendance(p_student_id text, p_date date, p_status text)
returns public.attendances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'Asia/Jakarta';
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_student_id text;
  v_name text;
  v_class_name text;
  v_gender text;
  v_row public.attendances;
begin
  if not public.is_admin() then
    raise exception 'Hanya guru yang dapat melakukan aksi ini.';
  end if;

  if p_status is null or p_status not in ('Hadir', 'Haid') then
    raise exception 'Status absensi tidak valid.';
  end if;
  if p_date > v_today then
    raise exception 'Absensi untuk tanggal mendatang belum tersedia.';
  end if;

  select s.id, s.name, s.class_name, s.gender
  into v_student_id, v_name, v_class_name, v_gender
  from public.students s
  where s.id = p_student_id
    and s.is_active;
  if v_student_id is null then
    raise exception 'Akun siswa tidak ditemukan atau nonaktif.';
  end if;

  if p_status = 'Haid' and v_gender is distinct from 'Perempuan' then
    raise exception 'Status Haid hanya untuk siswa perempuan.';
  end if;

  if exists (select 1 from public.holidays h where h.date = p_date) then
    raise exception 'Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.';
  end if;

  insert into public.attendances (
    id, student_id, student_name, class_name, date, time, status, recorded_by
  ) values (
    gen_random_uuid()::text, v_student_id, v_name, v_class_name, p_date,
    to_char(v_now, 'HH24.MI'), p_status, auth.uid()
  )
  on conflict (student_id, date) do nothing
  returning * into v_row;

  -- Already recorded: return the existing row unchanged.
  if not found then
    select a.* into v_row
    from public.attendances a
    where a.student_id = v_student_id
      and a.date = p_date;
  end if;

  return v_row;
end;
$$;

create or replace function public.admin_delete_attendance(p_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Hanya guru yang dapat melakukan aksi ini.';
  end if;

  delete from public.attendances a where a.id = p_id;
end;
$$;

create or replace function public.admin_set_holiday(p_date date, p_is_holiday boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Hanya guru yang dapat melakukan aksi ini.';
  end if;

  if p_is_holiday then
    insert into public.holidays (date) values (p_date)
    on conflict (date) do nothing;
  else
    delete from public.holidays h where h.date = p_date;
  end if;
end;
$$;

create or replace function public.admin_set_prayer_schedule(
  p_enabled boolean,
  p_start time,
  p_end time,
  p_attendance_start_date date
)
returns public.prayer_schedule
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.prayer_schedule;
begin
  if not public.is_admin() then
    raise exception 'Hanya guru yang dapat melakukan aksi ini.';
  end if;

  insert into public.prayer_schedule (id, enabled, start_time, end_time, attendance_start_date)
  values (1, p_enabled, p_start, p_end, p_attendance_start_date)
  on conflict (id) do update
  set enabled = excluded.enabled,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      attendance_start_date = excluded.attendance_start_date
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: authenticated only.
-- ---------------------------------------------------------------------------
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.current_student_id() from public, anon;
revoke execute on function public.submit_attendance(text) from public, anon;
revoke execute on function public.submit_late_attendance(date, text) from public, anon;
revoke execute on function public.admin_mark_attendance(text, date, text) from public, anon;
revoke execute on function public.admin_delete_attendance(text) from public, anon;
revoke execute on function public.admin_set_holiday(date, boolean) from public, anon;
revoke execute on function public.admin_set_prayer_schedule(boolean, time, time, date) from public, anon;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_student_id() to authenticated;
grant execute on function public.submit_attendance(text) to authenticated;
grant execute on function public.submit_late_attendance(date, text) to authenticated;
grant execute on function public.admin_mark_attendance(text, date, text) to authenticated;
grant execute on function public.admin_delete_attendance(text) to authenticated;
grant execute on function public.admin_set_holiday(date, boolean) to authenticated;
grant execute on function public.admin_set_prayer_schedule(boolean, time, time, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies for the authenticated role (old "public can ..." policies stay).
-- ---------------------------------------------------------------------------
drop policy if exists "auth: read students" on public.students;
create policy "auth: read students" on public.students
  for select to authenticated
  using ((select public.is_admin()) or auth_user_id = (select auth.uid()));

drop policy if exists "auth: read attendances" on public.attendances;
create policy "auth: read attendances" on public.attendances
  for select to authenticated
  using ((select public.is_admin()) or student_id = (select public.current_student_id()));

drop policy if exists "auth: read holidays" on public.holidays;
create policy "auth: read holidays" on public.holidays
  for select to authenticated
  using (true);

drop policy if exists "auth: read prayer schedule" on public.prayer_schedule;
create policy "auth: read prayer schedule" on public.prayer_schedule
  for select to authenticated
  using (true);

drop policy if exists "auth: read sync changes" on public.sync_changes;
create policy "auth: read sync changes" on public.sync_changes
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Tables outside this app: no API access.
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regclass('public.projects') is not null then
    revoke all on table public.projects from anon, authenticated;
  end if;
  if pg_catalog.to_regclass('public.site_settings') is not null then
    revoke all on table public.site_settings from anon, authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
