-- Rollback for supabase/migrations/20261030000000_auth_foundation.sql (Tahap 1).
-- Removes everything that migration created and restores the previous foreign key
-- and grants. The old "public can ..." policies are not touched.
-- Data loss: students.auth_user_id, students.is_active, attendances.recorded_by and
-- prayer_schedule.attendance_start_date are dropped with their values. After Tahap 2
-- this loses the student -> Auth user mapping (the Tahap 2 script can rebuild it:
-- migrate-auth-users tanpa --sync, laporan "ditautkan: <jumlah murid>"). Nonaktivasi
-- murid (is_active = false) HILANG: setelah rollback semua murid kembali aktif di
-- aplikasi lama; catat dulu daftar murid nonaktif bila perlu
-- (select id, username from public.students where not is_active).
--
-- Urutan rollback (wajib):
--   1. Vercel Instant Rollback ke deployment aplikasi lama (aplikasi baru memakai
--      kolom dan fungsi yang dihapus file ini).
--   2. Jika Tahap 4 sudah diterapkan: jalankan
--      supabase/rollback/20261030000100_close_public_access.sql lebih dulu.
--   3. Baru file ini.
-- Preflight di bawah menolak berjalan selama Tahap 4 masih diterapkan.
--
-- Jalankan di luar jendela dzuhur (11:00-15:30 WIB). Jika gagal karena lock timeout
-- atau deadlock, tidak ada yang berubah: jalankan ulang.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.students'::regclass
      and attname = 'password_legacy'
      and not attisdropped
  ) then
    raise exception 'Tahap 4 masih diterapkan (kolom students.password_legacy ada). Jalankan dulu supabase/rollback/20261030000100_close_public_access.sql, lalu file ini.';
  end if;
end $$;

-- Policies first: they depend on the helper functions.
drop policy if exists "auth: read students" on public.students;
drop policy if exists "auth: read attendances" on public.attendances;
drop policy if exists "auth: read holidays" on public.holidays;
drop policy if exists "auth: read prayer schedule" on public.prayer_schedule;
drop policy if exists "auth: read sync changes" on public.sync_changes;

drop function if exists public.submit_attendance(text);
drop function if exists public.submit_late_attendance(date, text);
drop function if exists public.admin_mark_attendance(text, date, text);
drop function if exists public.admin_delete_attendance(text);
drop function if exists public.admin_set_holiday(date, boolean);
drop function if exists public.admin_set_prayer_schedule(boolean, time, time, date);
drop function if exists public.current_student_id();
drop function if exists public.is_admin();

alter table public.attendances drop constraint if exists attendances_status_check;

alter table public.attendances
  drop constraint if exists attendances_student_id_fkey,
  add constraint attendances_student_id_fkey
    foreign key (student_id) references public.students(id) on delete cascade;

drop index if exists public.students_username_lower_idx;

alter table public.students
  drop column if exists auth_user_id,
  drop column if exists is_active;

alter table public.attendances
  drop column if exists recorded_by;

alter table public.prayer_schedule
  drop column if exists attendance_start_date;

do $$
begin
  if pg_catalog.to_regclass('public.projects') is not null then
    grant all on table public.projects to anon, authenticated;
  end if;
  if pg_catalog.to_regclass('public.site_settings') is not null then
    grant all on table public.site_settings to anon, authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
