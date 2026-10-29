# Desain: Pengamanan Login dan Akses Data dengan Supabase Auth

Tanggal: 2026-10-30
Branch: `security/supabase-auth`
Status: menunggu review

## 1. Latar belakang

Aplikasi absensi sholat dipakai 1.166 siswa setiap hari. Aplikasi di-deploy di Vercel (`https://absensi-sholat-three.vercel.app/`) dan memakai Supabase langsung dari browser dengan publishable key. Semua logika ada di `app/page.js`; belum ada API route.

Akses data saat ini tidak punya batas: siapa pun yang membuka DevTools bisa membaca, memalsukan, atau menghapus seluruh data.

## 2. Temuan

Temuan diverifikasi dari kode dan dari audit read-only database production (2026-10-29).

| # | Temuan | Bukti |
|---|---|---|
| 1 | Policy RLS `using (true)` / `with check (true)` untuk role `public` pada select, insert, update, delete di `students`, `attendances`; select, insert, delete di `holidays`; select, update di `prayer_schedule`; select di `sync_changes`. Kondisi production sama dengan `schema.sql`. | `supabase/schema.sql:150-167`, audit `pg_policies` |
| 2 | `anon` dan `authenticated` punya semua grant (termasuk `TRUNCATE`) di semua tabel publik. | audit `role_table_grants` |
| 3 | Seluruh siswa beserta password plaintext diambil ke browser **sebelum login**, lalu di-cache 29 hari di `localStorage` (`dzuhur-supabase-cache-v2`) pada setiap perangkat. | `app/page.js:536-540`, `652-670` |
| 4 | Login dicek di browser; sesi (`dzuhur-session`) berisi role dan password plaintext, bisa dipalsukan dengan mengedit `localStorage`. | `app/page.js:1003-1025` |
| 5 | Password guru hanya disimpan di `localStorage` perangkat yang menggantinya. Di perangkat lain password guru tetap `123`. | `app/page.js:503`, `565`, `1031` |
| 6 | Trigger `capture_sync_change` menyalin baris `students` utuh (termasuk password) ke `sync_changes.row_data`, yang bisa dibaca `anon` dan disiarkan realtime. Saat audit 0 baris berisi password (perubahan siswa terakhir > 30 hari lalu), tapi setiap edit siswa berikutnya akan membocorkan password. | `schema.sql:178-230`, audit `sync_bocor` |
| 7 | `students`, `attendances`, `holidays` ada di publication `supabase_realtime`; dengan policy terbuka, siapa pun bisa subscribe dan menerima baris `students` lengkap dengan password. Client tidak memakai channel ini. | `schema.sql:256-278`, audit `pg_publication_tables` |
| 8 | Absensi dipercaya dari client: `student_id`, `student_name`, `class_name`, `date`, `time`, `status` dikirim browser. Jendela waktu hanya dicek di UI. `status` tanpa CHECK. Status Haid tidak dicek gender. | `app/page.js:1073-1118`, `1722-1756` |
| 9 | `attendances.student_id` memakai `on delete cascade`; menghapus siswa menghapus riwayat absennya. | `schema.sql:14` |
| 10 | 1.165 dari 1.166 siswa masih memakai password `123`, dan username berpola `Kelas_NamaDepan`. | audit `siswa` |
| 11 | Tabel `projects` dan `site_settings` (bukan bagian aplikasi ini, 0 baris, RLS aktif) punya policy `auth.uid() = owner_id`. Setelah Supabase Auth aktif, setiap siswa yang login bisa menulis ke tabel itu. | audit |
| 12 | Fungsi `get_monthly_class_prayer_ranking` (`security definer`) bisa dipanggil `anon`. Datanya agregat, risiko rendah. | `schema.sql:124-125` |

Data audit lain yang dipakai desain ini:

- Tidak ada username yang bentrok setelah diubah ke huruf kecil, dan tidak ada username dengan karakter di luar `[A-Za-z0-9._-]`.
- `auth.users` kosong. Ekstensi `pgcrypto` 1.3 tersedia.
- `students.created_at` berkisar 2026-08-14 s/d 2026-08-26; absensi pertama 2026-08-01.

## 3. Tujuan

1. Login siswa dan guru diverifikasi server, bukan browser.
2. Password di-hash. Password yang ada dimigrasikan tanpa reset; siswa tetap bisa login dengan password lamanya.
3. `anon` tidak bisa membaca kolom password dan tidak bisa menulis ke tabel mana pun.
4. Siswa hanya bisa mengabsenkan dirinya sendiri, di dalam jendela `prayer_schedule`, dengan tanggal dan jam dari server.
5. Hanya guru yang bisa mengelola siswa, hari libur, jadwal, dan koreksi absensi untuk siswa lain.
6. Sesi tidak bisa dipalsukan dari `localStorage`.
7. Fitur yang ada tetap jalan: absensi, koreksi terlambat, rekap bulanan, ranking kelas, import/export xlsx, QR `/dzuhur`, sinkronisasi realtime admin, cache offline admin.
8. Migrasi production bertahap; tidak ada siswa yang gagal absen dan tidak ada data hilang.

## 4. Bukan cakupan

- Wajib ganti password `123`. Diputuskan tidak dilakukan (lihat risiko yang diterima, bagian 12).
- Akun per guru. Tetap satu akun `guru`.
- Memindahkan pembersihan `sync_changes` 30 hari ke job terjadwal.
- Refactor UI `app/page.js` di luar bagian yang disentuh.

## 5. Keputusan

| Topik | Keputusan | Alasan |
|---|---|---|
| Mekanisme auth | Supabase Auth | Hashing, JWT bertanda tangan, refresh token, dan pencabutan sesi sudah tersedia. Realtime dan RLS bekerja langsung dengan JWT. Beban absen jam dzuhur langsung ke Postgres. Siswa login lewat data seluler (banyak IP), jadi rate limit per IP bukan risiko utama. |
| Penulisan data | RPC `security definer` untuk absensi, hari libur, jadwal; API route Vercel (service role) untuk kelola siswa | Kelola siswa harus mengubah `auth.users` dan `students` sekaligus, yang butuh `auth.admin.*`. |
| Password `123` | Tetap berlaku | Keputusan pemilik produk. |
| Password guru | Password acak kuat dibuat saat migrasi; guru menggantinya lewat app | `guru`/`123` memberi akses admin penuh dan sudah berlaku di semua perangkat. |
| Kolom password di halaman admin | Diganti tombol "Reset password" | Password ter-hash tidak bisa ditampilkan. |
| Hapus siswa | Soft delete (`is_active = false`, akun Auth diblokir) | Riwayat absensi tetap untuk rekap, sesuai PRD. |
| Batas koreksi terlambat | Tanpa batas, kecuali `attendance_start_date` (default 2026-08-01) ≤ tanggal < hari ini, bukan hari libur, Haid hanya siswa perempuan | Menjaga perilaku sekarang sekaligus mencegah pengisian sebelum aplikasi dipakai. `created_at` tidak dipakai karena absensi pertama mendahului tanggal import siswa. |
| Realtime | Hanya admin | Siswa cukup mengambil ulang data saat halaman dibuka atau mendapat fokus; menghindari pengecekan RLS realtime untuk ribuan subscriber. |
| Cache offline | Hanya admin (daftar siswa tanpa password) | Perangkat siswa tidak perlu data siswa lain. |
| Mode demo `localStorage` tanpa Supabase | Dihapus | Menyimpan password plaintext dan menggandakan jalur kode. |
| Staging | Project Supabase cloud terpisah (`.env.staging.local`) + Vercel Preview diarahkan ke staging | Perilaku Auth, RLS, dan realtime identik dengan production. |
| Sesi | Siswa: login terus (refresh otomatis). Admin: logout otomatis setelah 7 hari tidak aktif, dicek di app | Supabase tidak mendukung timeout per role; inactivity timeout hanya tersedia per project di paket Pro. |

## 6. Arsitektur

```
Browser (siswa/guru)
 ├─ supabase.auth.signInWithPassword ──► Supabase Auth (bcrypt, JWT)
 ├─ select via RLS ────────────────────► Postgres (baca data sesuai role)
 ├─ rpc(...) ──────────────────────────► fungsi security definer (semua aturan dicek di sini)
 └─ fetch /api/admin/* (Bearer JWT) ───► Vercel route handler
                                            └─ service role ──► auth.admin.* + students
```

- Browser tidak pernah menulis langsung ke tabel.
- Service role key hanya dibaca di `lib/supabase-admin.js`, yang diawali `import "server-only"`. Env var-nya `SUPABASE_SERVICE_ROLE_KEY`, tidak pernah `NEXT_PUBLIC_*`.
- Sebelum menulis route handler, baca panduan Next 16 di `node_modules/next/dist/docs/` sesuai `AGENTS.md`.

## 7. Model data

Semua perubahan aditif kecuali yang ditandai Tahap 4/5.

### `students`

- Tambah `auth_user_id uuid unique references auth.users(id) on delete set null`.
- Tambah `is_active boolean not null default true`.
- Tambah unique index `students_username_lower_idx on (lower(username))`.
- Username `guru` dicadangkan; API menolak siswa dengan username itu.
- Kolom `password`: tetap sampai Tahap 4, lalu di-rename `password_legacy` tanpa grant untuk role mana pun; di-drop di Tahap 5.

### `attendances`

- Tambah `recorded_by uuid` (user Auth yang mencatat; `null` untuk baris lama).
- Tambah `constraint attendances_status_check check (status in ('Hadir', 'Terlambat', 'Haid')) not valid`, lalu `validate constraint` setelah nilai di production dicek.
- Ganti foreign key `student_id` dari `on delete cascade` ke `on delete restrict`.
- Format `time` tetap `HH24.MI` (contoh `11.45`), sama dengan `Intl.DateTimeFormat("id-ID")` yang dipakai sekarang.

### `prayer_schedule`

- Tambah `attendance_start_date date not null default '2026-08-01'`.

### Akun guru

- User Auth dengan email `guru@<domain-sintetis>` dan `app_metadata.role = 'admin'`. Tidak punya baris di `students`.

### Fungsi pembantu

- `public.is_admin()`: `coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'`.
- `public.current_student_id()`: `id` dari `students` dengan `auth_user_id = auth.uid()` dan `is_active`.
- Keduanya `stable`, `security definer`, `set search_path = ''`.

## 8. Login dan sesi

### Pemetaan akun

- Email = `lower(username) + "@absensi-sholat.local"`. Dihitung di client, tanpa query database, jadi tidak ada endpoint yang membocorkan apakah sebuah username terdaftar.
- Password Auth = `"absensi:" + passwordYangDiketik`. Supabase Auth mewajibkan minimal 6 karakter, sementara password yang ada `123`. Awalan ini konstan dan tidak boleh diubah selamanya, karena mengubahnya membuat semua password tidak cocok.
- Keduanya ada di `lib/auth.js` dan dipakai bersama oleh client, API route, dan script migrasi.
- Harus diverifikasi di staging: domain `absensi-sholat.local` lolos validasi email Auth. Kalau ditolak, pilih domain lain yang lolos, uji ulang di staging, lalu catat domain final di spec ini sebelum Tahap 2. Domain tidak boleh berubah setelah Tahap 2.

### Login

1. `supabase.auth.signInWithPassword({ email, password })`.
2. Role dibaca dari `session.user.app_metadata.role` (`admin` atau `student`).
3. Siswa mengambil profilnya: `students` dengan `auth_user_id = auth.uid()`, kolom `id, nis, name, class_name, gender, username`.
4. Gagal → "Username atau password belum sesuai." (pesan sama seperti sekarang).

### Sesi

- Disimpan supabase-js (`sb-<ref>-auth-token`), refresh otomatis.
- Admin: `dzuhur-admin-last-active` diperbarui saat ada aktivitas; jika lebih dari 7 hari, app menjalankan `signOut()`. Ini pengaman perangkat hilang, bukan kontrol terhadap token yang dicuri.

### Auto-migrasi sesi lama (sekali)

Saat app baru dibuka dan belum ada sesi Supabase:

- `dzuhur-session` berisi siswa dengan `username` dan `password` → login diam-diam. Berhasil atau gagal, data lama dihapus; gagal berarti tampil halaman login.
- `dzuhur-session` admin → dihapus, tampil halaman login.
- Selalu hapus: `dzuhur-session`, `dzuhur-teacher-password`, `dzuhur-supabase-cache-v2`, `dzuhur-students`, `dzuhur-attendances`, `dzuhur-holidays`, `dzuhur-prayer-schedule`.

### Ganti password (siswa dan guru)

1. Verifikasi password lama dengan `signInWithPassword`.
2. `supabase.auth.updateUser({ password: "absensi:" + passwordBaru })`.

### Reset password oleh guru

`POST /api/admin/students/[id]/password` → cek admin → `auth.admin.updateUserById`.

### Dashboard Auth (staging dan production)

- "Allow new users to sign up" dimatikan.
- Catat batas rate limit sign-in sebelum Tahap 3.

## 9. RLS dan RPC

### Hak akses akhir (setelah Tahap 4)

| Tabel | Siswa | Guru | `anon` |
|---|---|---|---|
| `students` | select baris sendiri | select semua | tidak ada |
| `attendances` | select milik sendiri | select semua | tidak ada |
| `holidays`, `prayer_schedule` | select | select | tidak ada |
| `sync_changes` | tidak ada | select | tidak ada |
| `projects`, `site_settings` | tidak ada | tidak ada | tidak ada |
| insert/update/delete/truncate tabel mana pun | tidak ada | tidak ada | tidak ada |

- `students`: column grant `select (id, nis, name, class_name, gender, username, is_active, created_at)` ke `authenticated`. Kolom password tidak termasuk.
- Policy baru memakai `to authenticated` dan `is_admin()` / `current_student_id()`.
- `get_server_time()`: tetap bisa dipanggil `anon`.
- `get_monthly_class_prayer_ranking`: diawali cek `is_admin()`, execute dicabut dari `anon`; hanya menghitung siswa aktif.

### RPC siswa

Semua `security definer`, `set search_path = ''`, identitas dari `current_student_id()`. Nama dan kelas diambil dari `students`; `id` dari `gen_random_uuid()::text`; `recorded_by = auth.uid()`. Error dikirim dengan `raise exception` berpesan Bahasa Indonesia.

`submit_attendance(p_status text)`:

- `p_status in ('Hadir', 'Haid')`; `Haid` hanya jika `gender = 'Perempuan'`.
- Tanggal `(now() at time zone 'Asia/Jakarta')::date`; jam `to_char(now() at time zone 'Asia/Jakarta', 'HH24.MI')`.
- Jika `prayer_schedule.enabled`: tolak jika menit sekarang < `start_time` ("Konfirmasi belum dibuka") atau > `end_time` ("Waktu konfirmasi sudah terlewat"). Perbandingan per menit, sama dengan client sekarang.
- Tolak hari libur dan siswa nonaktif.
- Jika sudah tercatat hari itu, kembalikan catatan yang ada tanpa insert (`on conflict (student_id, date) do nothing` lalu select).

`submit_late_attendance(p_date date, p_status text)`:

- `p_status in ('Terlambat', 'Haid')`; `Haid` hanya siswa perempuan.
- `attendance_start_date <= p_date < hari ini (WIB)`, bukan hari libur.
- Sudah tercatat → error "Absensi tanggal tersebut sudah tercatat."

### RPC guru

Semua diawali `if not public.is_admin() then raise exception ...`.

- `admin_mark_attendance(p_student_id text, p_date date, p_status text)`: status `Hadir`/`Haid` (Haid hanya perempuan), `p_date <= hari ini`, bukan hari libur, siswa aktif.
- `admin_delete_attendance(p_id text)`.
- `admin_set_holiday(p_date date, p_is_holiday boolean)`.
- `admin_set_prayer_schedule(p_enabled boolean, p_start time, p_end time, p_attendance_start_date date)`.

### API admin (Vercel route handler, service role)

Setiap route memverifikasi header `Authorization: Bearer <JWT>` dengan `auth.getUser(token)` lalu memastikan `app_metadata.role = 'admin'`.

| Route | Aksi |
|---|---|
| `POST /api/admin/students` | Buat user Auth + baris `students`. Jika insert `students` gagal, hapus user Auth. |
| `PATCH /api/admin/students/[id]` | Ubah data siswa; jika username berubah, ubah email Auth. |
| `DELETE /api/admin/students/[id]` | `is_active = false` + blokir user Auth (`ban_duration`). |
| `POST /api/admin/students/[id]/password` | Reset password. |
| `POST /api/admin/students/import` | Maksimal 100 siswa per request; mengembalikan hasil per baris (berhasil, duplikat, gagal). |

### Trigger sync (Tahap 4)

`capture_sync_change` untuk `students` hanya menyimpan `id, nis, name, class_name, gender, username, is_active`. Baris `sync_changes` lama yang berisi kunci `password` dihapus.

Perubahan ini sengaja ditunda ke Tahap 4: client lama membandingkan password dari state yang diperbarui lewat sync, jadi menghapus password lebih awal membuat siswa yang datanya baru diedit tidak bisa login di client lama.

## 10. Perubahan client

### File baru

- `lib/auth.js`: `usernameToEmail`, `toAuthPassword`, `migrateLegacySession`, pengecekan timeout admin.
- `lib/api.js`: pembungkus RPC dan pemanggil `/api/admin/*` yang menyertakan JWT.
- `lib/supabase-admin.js`: client service role, server-only.
- `app/api/admin/students/...`: route di bagian 9.

### `app/page.js`

- Hapus pengambilan siswa sebelum login dan perbandingan password di client.
- Ganti lima insert langsung (`recordAttendance`, `markStudentForDate`, `markStudentPresent`, `markStudentMenstruation`, toggle libur) dan update jadwal dengan RPC. Validasi di client tetap ada sebagai UX.
- Halaman data siswa: kolom Password → tombol "Reset password" dengan modal; form edit tanpa field password; form tambah tetap dengan default `123`; tombol hapus → "Nonaktifkan"; siswa nonaktif disembunyikan.
- Import: parsing dan preview tetap di browser; konfirmasi mengirim batch 100 ke API dengan indikator progres.
- Export xlsx, rekap, QR `/dzuhur`: tidak berubah (export tidak memuat password).
- Pengaturan: tambah input "Tanggal mulai absensi".
- Realtime `sync_changes`: hanya admin. Siswa mengambil ulang absensi sendiri, hari libur, dan jadwal saat halaman dibuka dan saat `focus`.
- Cache admin: kunci baru `dzuhur-cache-v3` tanpa password, dihapus saat logout.
- Hapus mode demo (`initialStudents` dan semua cabang `if (!supabase)`).

## 11. Tahap migrasi

Setiap tahap production hanya dijalankan setelah konfirmasi pemilik. Script rollback tiap tahap dites di staging sebelum dipakai.

### Tahap 0: persiapan (production tidak diubah)

- Pemilik menjalankan `pg_dump` production (schema `public` dan `auth`).
- Staging: jalankan `schema.sql` dan migrasi lama, isi data dummy, rekam bukti celah dengan `curl` + anon key.
- Semua kode di branch ini, dites terhadap staging. Env Preview Vercel diarahkan ke staging.
- Cek read-only production: `select distinct status from attendances`, contoh nilai `time`, rate limit Auth.

### Tahap 1: SQL aditif

File: `supabase/migrations/<YYYYMMDDHHMMSS>_auth_foundation.sql`, rollback `supabase/rollback/<YYYYMMDDHHMMSS>_auth_foundation.sql`.

- Kolom, constraint, index, fungsi pembantu, RPC, policy `to authenticated` baru.
- `revoke all on public.projects, public.site_settings from anon, authenticated`.
- Matikan pendaftaran publik Auth.
- Verifikasi: app lama tetap login dan absen; RPC baru ada (`pg_proc`).
- Rollback: drop objek baru, kembalikan grant `projects`/`site_settings`, kembalikan foreign key cascade.

### Tahap 2: akun Auth

`scripts/migrate-auth-users.mjs` (dijalankan dari Mac pemilik dengan env production):

- `--dry-run`: hanya laporan.
- Default: untuk setiap siswa tanpa `auth_user_id`, `auth.admin.createUser({ email, password: "absensi:" + password, email_confirm: true, app_metadata: { role: "student", student_id } })`, lalu isi `auth_user_id`. Idempoten.
- `--sync`: tambahan, set ulang password Auth dari kolom `password` untuk siswa yang sudah punya akun.
- Membuat akun `guru` jika belum ada, dengan password acak yang hanya dicetak sekali ke terminal.
- Verifikasi: jumlah user Auth role student = jumlah siswa aktif; login contoh beberapa siswa berhasil.
- Rollback: hapus user Auth yang dibuat script, `update students set auth_user_id = null`.

### Tahap 3: deploy app baru (Jumat sore atau akhir pekan)

1. Isi `SUPABASE_SERVICE_ROLE_KEY` di env Production Vercel.
2. Jalankan script Tahap 2 tanpa flag, lalu dengan `--sync`.
3. Merge PR; Vercel deploy otomatis.

- Verifikasi: login siswa (termasuk auto-migrasi), absen, koreksi, dashboard dan realtime admin, rekap, export, ranking, import, reset password, nonaktifkan. Pantau log Supabase pada jam dzuhur pertama.
- Rollback: Instant Rollback di Vercel. Policy lama masih ada sehingga app lama langsung berfungsi; absensi dari app baru tetap terbaca.

### Tahap 4: tutup akses lama (minimal 3 hari sekolah setelah Tahap 3 stabil)

File: `supabase/migrations/<YYYYMMDDHHMMSS>_close_public_access.sql`, rollback `supabase/rollback/<YYYYMMDDHHMMSS>_close_public_access.sql`.

- Drop semua policy `public can ...`.
- `revoke all` di semua tabel aplikasi dari `anon`; `revoke insert, update, delete, truncate` dari `authenticated`; column grant `students`.
- Keluarkan `students`, `attendances`, `holidays` dari `supabase_realtime`.
- Perbarui `capture_sync_change`; hapus baris `sync_changes` yang berisi password.
- `alter table students rename column password to password_legacy`; cabut semua grant kolom itu.
- `get_monthly_class_prayer_ranking` hanya admin.
- Rollback: buat ulang policy dan grant lama, rename kolom kembali, kembalikan trigger dan publication.

### Tahap 5: pembersihan (setelah 2 minggu stabil)

- `alter table students drop column password_legacy`.
- `schema.sql` diperbarui sesuai kondisi akhir.
- Folder `deploy/` (nginx/systemd) ditandai usang di README karena produksi berjalan di Vercel.

## 12. Verifikasi dan testing

### Otomatis

- `node --test lib/*.test.js`: `usernameToEmail`, `toAuthPassword`, `migrateLegacySession`, timeout admin. Tanpa dependency baru.
- `supabase/tests/security.sql` via `psql` ke staging: mensimulasikan `anon`, siswa, siswa lain, dan admin dengan `set local role` + `set local request.jwt.claims`, dan memastikan:
  - `anon` tidak bisa select/insert/update/delete tabel aplikasi;
  - siswa tidak bisa membaca data siswa lain atau kolom password, dan tidak bisa insert langsung;
  - `submit_attendance` menolak di luar jendela, di hari libur, Haid untuk laki-laki, dan tidak membuat baris kedua;
  - `submit_late_attendance` menolak tanggal sebelum `attendance_start_date`, hari ini, dan masa depan;
  - RPC admin menolak non-admin.
- `scripts/verify-security.mjs`: cek HTTP dengan anon key dan JWT siswa (REST dan realtime). Dijalankan ke staging, dan ke production setelah Tahap 4. Uji tulis di production memakai penanda jelas (hari libur `1900-01-01`) dan langsung dibersihkan bila ternyata lolos.

### Manual

- Di URL Preview Vercel (staging) dari HP: login, absen, Haid, koreksi, ganti password, auto-migrasi sesi lama (isi `dzuhur-session` versi lama lalu buka app), edit `localStorage` untuk mencoba menjadi admin.
- Di production setelah Tahap 3 dan Tahap 4: daftar periksa yang sama untuk alur siswa dan guru.

## 13. Risiko

### Diterima pemilik

- Password `123` tetap berlaku untuk 1.165 siswa dan username mudah ditebak; "titip absen" dengan login sebagai siswa lain tetap mungkin.
- Token sesi disimpan di `localStorage`; tidak bisa dipalsukan, tapi bisa dicuri jika ada XSS.
- Persentase ranking bulan lalu bisa bergeser karena hanya siswa aktif yang dihitung.

### Dimitigasi

- Lonjakan login saat cutover: auto-migrasi sesi lama, deploy di luar jam sekolah, cek batas rate limit Auth.
- Siswa yang mengganti password atau ditambahkan lewat app lama antara Tahap 2 dan 3: script dijalankan ulang dengan `--sync` sesaat sebelum merge.
- Salah koneksi ke production saat pengembangan: semua perintah staging memeriksa bahwa host tidak mengandung ref project production.
