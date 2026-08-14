create table if not exists public.students (
  id text primary key,
  nis text,
  name text not null,
  class_name text not null,
  gender text check (gender in ('Laki-laki', 'Perempuan') or gender is null),
  username text unique not null,
  password text not null default '123',
  created_at timestamptz not null default now()
);

create table if not exists public.attendances (
  id text primary key,
  student_id text not null references public.students(id) on delete cascade,
  student_name text not null,
  class_name text not null,
  date date not null,
  time text not null,
  status text not null default 'Hadir',
  created_at timestamptz not null default now(),
  unique (student_id, date)
);

alter table public.students enable row level security;
alter table public.attendances enable row level security;

-- Temporary policies for the current username/password flow.
-- Replace these with authenticated-user policies before production launch.
drop policy if exists "public can read students" on public.students;
drop policy if exists "public can insert students" on public.students;
drop policy if exists "public can update students" on public.students;
drop policy if exists "public can delete students" on public.students;
drop policy if exists "public can read attendances" on public.attendances;
drop policy if exists "public can insert attendances" on public.attendances;
drop policy if exists "public can update attendances" on public.attendances;
create policy "public can read students" on public.students for select using (true);
create policy "public can insert students" on public.students for insert with check (true);
create policy "public can update students" on public.students for update using (true) with check (true);
create policy "public can delete students" on public.students for delete using (true);
create policy "public can read attendances" on public.attendances for select using (true);
create policy "public can insert attendances" on public.attendances for insert with check (true);
create policy "public can update attendances" on public.attendances for update using (true) with check (true);

create index if not exists attendances_date_idx on public.attendances(date);
create index if not exists attendances_student_idx on public.attendances(student_id);
