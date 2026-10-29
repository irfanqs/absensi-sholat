-- Rollback for supabase/migrations/20261030000000_auth_foundation.sql (Tahap 1).
-- Removes everything that migration created and restores the previous foreign key
-- and grants. The old "public can ..." policies are not touched.
-- Data loss: students.auth_user_id, students.is_active, attendances.recorded_by and
-- prayer_schedule.attendance_start_date are dropped with their values. After Tahap 2
-- this loses the student -> Auth user mapping (the Tahap 2 script can rebuild it).

begin;

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
