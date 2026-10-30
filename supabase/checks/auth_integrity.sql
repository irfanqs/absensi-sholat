-- Integritas Auth <-> students (read-only). Tempel di Supabase SQL Editor.
-- Wajib mengembalikan 0 baris sebelum merge (Tahap 3) dan sebelum Tahap 4.
-- Setiap baris = id murid yang akunnya tidak cocok: belum tertaut, akun Auth hilang,
-- email tidak sama dengan lower(username)@absensi-sholat.local (mis. username diganti
-- di aplikasi lama setelah Tahap 2), atau app_metadata bukan milik murid ini.
-- Cara memperbaiki: lihat runbook (plan Task 13/14). Jangan pakai --sync setelah Tahap 3.

select s.id
from public.students s
left join auth.users u on u.id = s.auth_user_id
where u.id is null
   or u.email <> lower(s.username) || '@absensi-sholat.local'
   or u.raw_app_meta_data ->> 'student_id' is distinct from s.id
   or u.raw_app_meta_data ->> 'role' is distinct from 'student'
order by s.id;
