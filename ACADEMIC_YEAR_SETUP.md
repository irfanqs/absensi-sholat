# Pergantian Tahun Ajaran (SMA)

Fitur ini masih berada di branch `feature/academic-year-transition`. Jangan gabungkan ke production sebelum diuji dan sistem autentikasi diamankan.

## Alur guru

1. Masuk sebagai guru, pilih **Tahun Ajaran**.
2. Lihat pratinjau: X naik ke XI, XI naik ke XII, XII diarsipkan.
3. Periksa bahwa tahun ajaran aktif benar, buat backup Supabase dan ekspor rekap.
4. Ketik tahun ajaran berikutnya dan kode rahasia; konfirmasi satu kali.
5. Import murid baru kelas X melalui menu Data Murid.

Arsip **tidak menghapus** baris murid ataupun riwayat pada `attendances`. Kolom `class_name` di `attendances` tetap menyimpan kelas saat absen dicatat. Akun alumni tidak boleh dipakai untuk absensi baru.

## Konfigurasi database (wajib oleh pengelola aplikasi)

1. Backup Supabase terlebih dahulu.
2. Jalankan `supabase/migrations/20261009000000_academic_year_transition.sql` melalui SQL Editor Supabase.
3. Sesuaikan **tahun ajaran aktif SEBELUM PROMOSI** secara manual; skrip default memakai `2025/2026` hanya sebagai placeholder. Contoh:

```sql
update public.academic_year_state set current_year='2025/2026' where id=1;
```

4. Atur kode konfirmasi yang kuat lewat SQL Editor (jangan bagikan ke murid atau simpan di kode frontend):

```sql
insert into app_private.academic_year_access(id,password_hash)
values (1, extensions.crypt('GANTI_DENGAN_KODE_RAHASIA_PANJANG', extensions.gen_salt('bf')))
on conflict (id) do update set password_hash=excluded.password_hash;
```

5. Pastikan semua kelas aktif mengikuti pola X-01, XI-01, XII-01 (atau X, XI, XII), dan uji pada database salinan sebelum digunakan.

## Penting: belum siap produksi

Sistem login existing masih berbasis password teks biasa di browser, dan policy RLS lama membolehkan pengguna publik memperbarui data murid. Kode rahasia pergantian tahun hanya melindungi pemanggilan prosedur promosi; **belum** dapat melindungi semua perubahan siswa dari akses langsung ke Supabase. Sebelum digunakan di sekolah, migrasikan ke Supabase Auth dan RLS berbasis peran, termasuk membatasi akses ke data sensitif dan operasi massal.

Fitur membutuhkan database Supabase, bukan fallback localStorage. Setelah memasang migrasi, lakukan pengujian login alumni, filter siswa, histori laporan, kenaikan kelas, dan format kelas. Tidak ada perubahan data production yang dilakukan oleh commit ini.
