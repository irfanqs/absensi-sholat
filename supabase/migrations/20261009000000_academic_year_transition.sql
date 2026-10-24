-- Jalankan di Supabase SQL Editor sebelum memakai fitur tahun ajaran.
-- Password administrasi untuk pergantian tahun diatur tersendiri, bukan password login demo.
create extension if not exists pgcrypto with schema extensions;
alter table public.students add column if not exists is_active boolean not null default true;
alter table public.students add column if not exists archived_at timestamptz;
alter table public.students add column if not exists graduation_year text;
create table if not exists public.academic_year_state (
  id integer primary key check (id = 1),
  current_year text not null,
  updated_at timestamptz not null default now()
);
insert into public.academic_year_state(id,current_year)
values (1, '2025/2026') on conflict (id) do nothing;

-- Tabel kredensial tidak dapat dibaca lewat API publik.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
create table if not exists app_private.academic_year_access (
  id integer primary key check (id = 1),
  password_hash text not null
);
revoke all on app_private.academic_year_access from public, anon, authenticated;

-- WAJIB DIGANTI dengan kode rahasia kuat sebelum fitur dapat dijalankan:
-- insert into app_private.academic_year_access(id,password_hash)
-- values (1, extensions.crypt('GANTI_DENGAN_KODE_RAHASIA_PANJANG', extensions.gen_salt('bf')))
-- on conflict (id) do update set password_hash=excluded.password_hash;

create or replace function public.promote_academic_year(p_new_year text, p_admin_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_year text;
  v_hash text;
  v_x integer;
  v_xi integer;
  v_xii integer;
begin
  if auth.uid() is null or coalesce(auth.jwt() -> 'app_metadata' ->> 'role','') <> 'admin' then
    raise exception 'Hanya akun Supabase Auth dengan peran admin yang dapat mengubah tahun ajaran';
  end if;
  if p_new_year !~ '^20[0-9]{2}/20[0-9]{2}
     or split_part(p_new_year,'/',2)::int <> split_part(p_new_year,'/',1)::int + 1 then
    raise exception 'Format tahun ajaran tidak valid';
  end if;
  select password_hash into v_hash from app_private.academic_year_access where id=1;
  if v_hash is null or p_admin_code is null
     or extensions.crypt(p_admin_code,v_hash) is distinct from v_hash then
    raise exception 'Kode konfirmasi pergantian tahun salah atau belum disiapkan';
  end if;
  select current_year into v_old_year
    from public.academic_year_state where id=1 for update;
  if v_old_year is null or split_part(p_new_year,'/',1)::int <> split_part(v_old_year,'/',1)::int+1 then
    raise exception 'Tahun ajaran harus tepat satu tahun setelah tahun aktif';
  end if;
  -- Tolak kelas tak dikenal agar tidak ada siswa aktif terlewat.
  if exists(select 1 from public.students where is_active and
    class_name !~ '^(X|XI|XII)([- ].+)?$') then
    raise exception 'Ada format kelas di luar X/XI/XII. Periksa data murid terlebih dahulu';
  end if;
  select count(*) into v_x from public.students where is_active and class_name ~ '^X([- ].+)?$';
  select count(*) into v_xi from public.students where is_active and class_name ~ '^XI([- ].+)?$';
  select count(*) into v_xii from public.students where is_active and class_name ~ '^XII([- ].+)?$';

  -- Arsip kelas XII terlebih dahulu. Jangan hapus rows maupun absensi.
  update public.students set is_active=false, archived_at=now(), graduation_year=p_new_year
    where is_active and class_name ~ '^XII([- ].+)?$';
  update public.students set class_name=regexp_replace(class_name,'^XI','XII')
    where is_active and class_name ~ '^XI([- ].+)?$';
  update public.students set class_name=regexp_replace(class_name,'^X','XI')
    where is_active and class_name ~ '^X([- ].+)?$';
  update public.academic_year_state set current_year=p_new_year,updated_at=now() where id=1;
  return jsonb_build_object('previous_year',v_old_year,'new_year',p_new_year,
    'promoted_x',v_x,'promoted_xi',v_xi,'archived_xii',v_xii);
end;
$$;
revoke all on function public.promote_academic_year(text,text) from public;
revoke execute on function public.promote_academic_year(text,text) from anon;
grant execute on function public.promote_academic_year(text,text) to authenticated;

-- Pertahankan histori dan cegah pencatatan baru untuk alumni, termasuk lewat API langsung.
create or replace function public.reject_archived_student_attendance()
returns trigger language plpgsql security definer set search_path = '' as $
begin
  if not exists (select 1 from public.students s where s.id = new.student_id and s.is_active = true) then
    raise exception 'Siswa tidak aktif tidak dapat mengisi absensi';
  end if;
  return new;
end; $;
revoke all on function public.reject_archived_student_attendance() from public, anon, authenticated;
drop trigger if exists reject_archived_student_attendance on public.attendances;
create trigger reject_archived_student_attendance before insert or update of student_id on public.attendances
for each row execute function public.reject_archived_student_attendance();
grant select on public.academic_year_state to anon, authenticated;
alter table public.academic_year_state enable row level security;
drop policy if exists "read academic year" on public.academic_year_state;
create policy "read academic year" on public.academic_year_state for select using (true);
notify pgrst, 'reload schema';

     or split_part(p_new_year,'/',2)::int <> split_part(p_new_year,'/',1)::int + 1 then
    raise exception 'Format tahun ajaran tidak valid';
  end if;
  select password_hash into v_hash from app_private.academic_year_access where id=1;
  if v_hash is null or p_admin_code is null
     or extensions.crypt(p_admin_code,v_hash) is distinct from v_hash then
    raise exception 'Kode konfirmasi pergantian tahun salah atau belum disiapkan';
  end if;
  select current_year into v_old_year
    from public.academic_year_state where id=1 for update;
  if v_old_year is null or split_part(p_new_year,'/',1)::int <> split_part(v_old_year,'/',1)::int+1 then
    raise exception 'Tahun ajaran harus tepat satu tahun setelah tahun aktif';
  end if;
  -- Tolak kelas tak dikenal agar tidak ada siswa aktif terlewat.
  if exists(select 1 from public.students where is_active and
    class_name !~ '^(X|XI|XII)([- ].+)?$') then
    raise exception 'Ada format kelas di luar X/XI/XII. Periksa data murid terlebih dahulu';
  end if;
  select count(*) into v_x from public.students where is_active and class_name ~ '^X([- ].+)?$';
  select count(*) into v_xi from public.students where is_active and class_name ~ '^XI([- ].+)?$';
  select count(*) into v_xii from public.students where is_active and class_name ~ '^XII([- ].+)?$';

  -- Arsip kelas XII terlebih dahulu. Jangan hapus rows maupun absensi.
  update public.students set is_active=false, archived_at=now(), graduation_year=p_new_year
    where is_active and class_name ~ '^XII([- ].+)?$';
  update public.students set class_name=regexp_replace(class_name,'^XI','XII')
    where is_active and class_name ~ '^XI([- ].+)?$';
  update public.students set class_name=regexp_replace(class_name,'^X','XI')
    where is_active and class_name ~ '^X([- ].+)?$';
  update public.academic_year_state set current_year=p_new_year,updated_at=now() where id=1;
  return jsonb_build_object('previous_year',v_old_year,'new_year',p_new_year,
    'promoted_x',v_x,'promoted_xi',v_xi,'archived_xii',v_xii);
end;
$$;
revoke all on function public.promote_academic_year(text,text) from public;
grant execute on function public.promote_academic_year(text,text) to anon, authenticated;
grant select on public.academic_year_state to anon, authenticated;
alter table public.academic_year_state enable row level security;
drop policy if exists "read academic year" on public.academic_year_state;
create policy "read academic year" on public.academic_year_state for select using (true);
notify pgrst, 'reload schema';
