-- Staging seed. Run from repo root: scripts/staging.sh psql -f supabase/seed/staging.sql
create temp table _seed (nama_lengkap text, kelas text, username text, password text);
\copy _seed from 'data/dummy-students.csv' with (format csv, header true)

insert into students (id, name, class_name, username, password, gender, created_at)
select gen_random_uuid()::text, nama_lengkap, kelas, username, password,
       case when row_number() over (order by username) % 2 = 1 then 'Laki-laki' else 'Perempuan' end,
       '2026-08-14'
from _seed
on conflict (username) do nothing;
