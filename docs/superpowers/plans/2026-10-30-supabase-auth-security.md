# Pengamanan Login dan Akses Data dengan Supabase Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengganti login di browser dan RLS terbuka dengan Supabase Auth, RLS per role, dan RPC `security definer`, lalu memigrasikan production secara bertahap tanpa siswa gagal absen.

**Architecture:** Browser login lewat `supabase.auth.signInWithPassword` dengan email sintetis dan password berawalan. Pembacaan lewat RLS, penulisan absensi/libur/jadwal lewat RPC yang mengambil identitas dari `auth.uid()` dan waktu dari server. Kelola siswa lewat route handler Vercel dengan service role (server-only).

**Tech Stack:** Next.js 16.3 (App Router, JavaScript), React 19, `@supabase/supabase-js` 2.x, Supabase Postgres + Auth + Realtime, `psql`, `node:test` (Node 20).

**Spec:** `docs/superpowers/specs/2026-10-30-supabase-auth-security-design.md`

## Global Constraints

- Jangan pernah menjalankan SQL ke production, push, atau deploy tanpa konfirmasi eksplisit pemilik. Task 11–15 masing-masing diawali STOP.
- Service role key hanya dibaca di `lib/supabase-admin.js`. Env var `SUPABASE_SERVICE_ROLE_KEY`, tidak pernah `NEXT_PUBLIC_*`, tidak pernah di-import dari kode client.
- Semua perintah ke staging lewat `scripts/staging.sh` (Task 1), yang menolak jalan kalau URL mengandung ref project production dari `.env.local`.
- Jangan pernah menampilkan isi `.env.local`, `.env.staging.local`, atau secret lain ke output.
- Sebelum menulis kode Next, baca panduan terkait di `node_modules/next/dist/docs/` (lihat `AGENTS.md`).
- `AUTH_EMAIL_DOMAIN = "absensi-sholat.local"`, `AUTH_PASSWORD_PREFIX = "absensi:"`. Tidak boleh berubah setelah Tahap 2.
- Username `guru` dicadangkan untuk akun admin.
- Status absensi hanya `Hadir`, `Terlambat`, `Haid`. Zona waktu `Asia/Jakarta`. Format kolom `time` `HH24.MI` (contoh `11.45`).
- `prayer_schedule.attendance_start_date` default `2026-08-01`.
- Kolom `students` yang boleh dibaca `authenticated`: `id, nis, name, class_name, gender, username, is_active, created_at`.
- Tidak ada dependency baru, kecuali `server-only` bila panduan Next 16 mengharuskan instalasinya.
- Gaya kode mengikuti `app/page.js`: JavaScript, tanda kutip ganda, indentasi 2 spasi, teks UI Bahasa Indonesia.
- Pesan error server (dipakai persis):
  - `E_NO_STUDENT` = `Akun siswa tidak ditemukan atau nonaktif.`
  - `E_STATUS` = `Status absensi tidak valid.`
  - `E_HAID` = `Status Haid hanya untuk siswa perempuan.`
  - `E_BEFORE` = `Konfirmasi sholat Dzuhur tersedia mulai pukul <HH.MM> WIB.`
  - `E_AFTER` = `Waktu konfirmasi berakhir pukul <HH.MM> WIB. Harap konfirmasi ke guru bila terjadi kesalahan.`
  - `E_HOLIDAY` = `Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.`
  - `E_LATE_RANGE` = `Tanggal koreksi di luar rentang yang diizinkan.`
  - `E_LATE_EXISTS` = `Absensi tanggal tersebut sudah tercatat.`
  - `E_FUTURE` = `Absensi untuk tanggal mendatang belum tersedia.`
  - `E_NOT_ADMIN` = `Hanya guru yang dapat melakukan aksi ini.`
  - `E_LOGIN` = `Username atau password belum sesuai.`

## Review Focus

1. Siswa membuka halaman sebelum 00.00 WIB lalu absen setelahnya: tanggal yang tercatat harus tanggal server, dan UI memakai baris yang dikembalikan RPC, bukan tanggal client. Diuji di Task 3 (`returned_row_uses_server_date`) dan Task 8 langkah manual.
2. Dobel tap atau dua tab mengirim absen bersamaan: hanya satu baris, keduanya melihat sukses. Diuji di Task 3 (`submit_twice_returns_same_row`).
3. Username diketik dengan huruf besar/kecil berbeda atau spasi di tepi (`" 9d_kevin "`): tetap bisa login. Password tidak di-trim. Diuji di Task 2.
4. Refresh token kedaluwarsa atau dicabut (siswa dinonaktifkan) saat app terbuka: app kembali ke halaman login dengan pesan, tidak blank. Diuji di Task 7 langkah manual dan Task 3 (`inactive_student_rejected`).
5. Import berisi username yang bentrok beda huruf dengan data lama (`9d_kevin` vs `9D_Kevin`): dilaporkan sebagai duplikat per baris, bukan error 500 untuk seluruh batch. Diuji di Task 6 (`import_reports_case_insensitive_duplicate`).

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `scripts/staging.sh` | Guard ref production + menjalankan `psql`/perintah dengan env staging |
| `supabase/seed/staging.sql` | Data dummy staging dari `data/dummy-students.csv` |
| `supabase/migrations/20261030000000_auth_foundation.sql` | Tahap 1 (aditif) |
| `supabase/rollback/20261030000000_auth_foundation.sql` | Rollback Tahap 1 |
| `supabase/migrations/20261030000100_close_public_access.sql` | Tahap 4 |
| `supabase/rollback/20261030000100_close_public_access.sql` | Rollback Tahap 4 |
| `supabase/migrations/20261030000200_drop_legacy_password.sql` | Tahap 5 |
| `supabase/tests/rpc.sql` | Tes RPC (berlaku setelah Tahap 1) |
| `supabase/tests/access.sql` | Tes RLS/grant (berlaku setelah Tahap 4) |
| `lib/auth.js` + `lib/auth.test.mjs` | Pemetaan akun, migrasi sesi lama, timeout admin (pure) |
| `lib/admin-students.js` + `lib/admin-students.test.mjs` | Validasi input siswa (pure) + operasi kelola siswa (service role) |
| `lib/supabase-admin.js` | Client service role, server-only |
| `lib/admin-auth.js` | `requireAdmin(request)` untuk route handler |
| `lib/api.js` | Pembungkus RPC dan `/api/admin/*` untuk client |
| `app/api/admin/students/**/route.js` | Route kelola siswa |
| `scripts/migrate-auth-users.mjs` | Tahap 2: buat/sinkron akun Auth |
| `scripts/verify-security.mjs` | Bukti HTTP sebelum/sesudah |
| `docs/superpowers/evidence/*.md` | Hasil verifikasi per tahap |
| `app/page.js` | Alur auth, penulisan via RPC/API, UI kelola siswa |

---

### Task 1: Tooling staging, bootstrap, bukti "sebelum", dan spike Auth

**Files:**
- Create: `scripts/staging.sh`, `supabase/seed/staging.sql`, `docs/superpowers/evidence/staging-before.md`

**Interfaces:**
- Produces: `scripts/staging.sh psql [psql args...]` (menjalankan `psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 ...`) dan `scripts/staging.sh run <cmd...>` (menjalankan perintah dengan semua variabel file env di-export). File env = `${STAGING_ENV_FILE:-.env.staging.local}`. Keduanya exit 1 dengan pesan `Ditolak: target mengandung ref production.` bila `NEXT_PUBLIC_SUPABASE_URL` atau `STAGING_DATABASE_URL` di file env mengandung ref dari `NEXT_PUBLIC_SUPABASE_URL` di `.env.local`.

- [ ] **Step 1: Tulis `scripts/staging.sh`** (bash, `set -euo pipefail`, `chmod +x`). Ref diambil dengan regex `https://([a-z0-9]+)\.supabase\.co`. Gagal juga bila ref staging kosong.

- [ ] **Step 2: Uji guard**

Run: `scripts/staging.sh psql -A -t -c "select 'ok'"`
Expected: `ok`
Run: `STAGING_ENV_FILE=.env.local scripts/staging.sh psql -c "select 1"`
Expected: exit 1, `Ditolak: target mengandung ref production.`, tanpa koneksi ke database.

- [ ] **Step 3: Bootstrap schema staging**

Run: `scripts/staging.sh psql -f supabase/schema.sql && for f in supabase/migrations/2026092*.sql; do scripts/staging.sh psql -f "$f"; done`
Expected: tanpa error; `scripts/staging.sh psql -A -t -c "select count(*) from pg_policies where schemaname='public'"` = `14`.

- [ ] **Step 4: Tulis dan jalankan `supabase/seed/staging.sql`**

Isi siswa dari `data/dummy-students.csv` (kolom `nama_lengkap,kelas,username,password`) memakai `\copy` ke tabel temp, `id = gen_random_uuid()::text`, `gender` bergantian `Laki-laki`/`Perempuan` menurut `row_number()`, `created_at = '2026-08-14'`. Idempoten (`on conflict (username) do nothing`).
Run: `scripts/staging.sh psql -f supabase/seed/staging.sql && scripts/staging.sh psql -A -t -c "select count(*) from students"`
Expected: `40`

- [ ] **Step 5: Spike Auth (domain email + awalan password)**

Dengan `scripts/staging.sh run node --input-type=module -e '...'` dan supabase-js service role: `auth.admin.createUser({ email: "spike_test@absensi-sholat.local", password: "absensi:123", email_confirm: true })`, lalu `signInWithPassword` memakai publishable key, lalu `auth.admin.deleteUser`.
Expected: create dan sign-in berhasil. **Kalau salah satu ditolak: STOP**, laporkan pesan error ke pemilik, dan perbarui spec bagian 8 sebelum lanjut.

- [ ] **Step 6: Rekam bukti "sebelum"**

Dengan `curl` ke `$NEXT_PUBLIC_SUPABASE_URL/rest/v1/students?select=username,password&limit=2` memakai header `apikey` publishable key (via `scripts/staging.sh run bash -c '...'`). Tulis ke `docs/superpowers/evidence/staging-before.md`: perintah (tanpa key), status HTTP, dan jumlah baris (bukan isinya). Ulangi untuk insert `holidays` (`1900-01-01`) lalu delete-nya.
Expected: select 200 berisi kolom password; insert 201; delete 204.

- [ ] **Step 7: Commit**

```bash
git add scripts/staging.sh supabase/seed/staging.sql docs/superpowers/evidence/staging-before.md
git commit -m "chore: add guarded staging tooling and seed data"
```

---

### Task 2: `lib/auth.js` (pure)

**Files:**
- Create: `lib/auth.js`, `lib/auth.test.mjs`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces:
  - `AUTH_EMAIL_DOMAIN: string`, `AUTH_PASSWORD_PREFIX: string`
  - `usernameToEmail(username: string): string` — trim + lowercase + `@` + domain; throw `Error("Username tidak valid.")` bila kosong atau tidak cocok `^[a-z0-9._-]+$` setelah lowercase.
  - `toAuthPassword(password: string): string` — awalan + password apa adanya (tanpa trim).
  - `LEGACY_STORAGE_KEYS: string[]` — `dzuhur-session`, `dzuhur-teacher-password`, `dzuhur-supabase-cache-v2`, `dzuhur-students`, `dzuhur-attendances`, `dzuhur-holidays`, `dzuhur-prayer-schedule`.
  - `migrateLegacySession(storage: Storage, signIn: (username: string, password: string) => Promise<boolean>): Promise<"migrated" | "failed" | "none">` — baca `dzuhur-session`; bila objek siswa (`role === "student"`, `username` dan `password` string) panggil `signIn`; selalu hapus semua `LEGACY_STORAGE_KEYS` sebelum return; JSON rusak = tidak ada kredensial.
  - `ADMIN_ACTIVITY_KEY = "dzuhur-admin-last-active"`, `ADMIN_IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000`
  - `isAdminSessionExpired(lastActive: number | null, now: number): boolean` — `null` → `false`.
  - `signInWithUsername(client, username: string, password: string): Promise<{ error: string | null }>` — memanggil `client.auth.signInWithPassword`; username tidak valid atau error Auth → `{ error: E_LOGIN }`.

- [ ] **Step 1: Tulis tes `lib/auth.test.mjs`** (`node:test` + `node:assert/strict`, storage palsu berbasis `Map`, client palsu):

```js
test("usernameToEmail normalizes case and whitespace", () => {
  assert.equal(usernameToEmail(" 9D_Kevin "), "9d_kevin@absensi-sholat.local");
});
test("usernameToEmail rejects empty and unsafe usernames", () => {
  assert.throws(() => usernameToEmail("  "));
  assert.throws(() => usernameToEmail("a b"));
  assert.throws(() => usernameToEmail("x@y"));
});
test("toAuthPassword keeps the password verbatim", () => {
  assert.equal(toAuthPassword("123"), "absensi:123");
  assert.equal(toAuthPassword(" 123"), "absensi: 123");
});
test("migrateLegacySession signs in legacy student and clears every legacy key", async () => {
  // storage berisi dzuhur-session {role:"student",username:"9A_Irfan",password:"123"} + semua LEGACY_STORAGE_KEYS lain
  // signIn mencatat argumen dan mengembalikan true
  // expect: "migrated", signIn dipanggil dengan ("9A_Irfan","123"), semua key terhapus
});
test("migrateLegacySession returns failed when sign-in fails", /* signIn → false; expect "failed", key terhapus */);
test("migrateLegacySession ignores admin and corrupt sessions", /* {role:"admin"} → "none"; "{" → "none"; signIn tidak dipanggil; key terhapus */);
test("migrateLegacySession returns none without legacy data", /* storage kosong → "none" */);
test("isAdminSessionExpired", () => {
  const now = Date.UTC(2026, 9, 30);
  assert.equal(isAdminSessionExpired(null, now), false);
  assert.equal(isAdminSessionExpired(now - ADMIN_IDLE_LIMIT_MS, now), false);
  assert.equal(isAdminSessionExpired(now - ADMIN_IDLE_LIMIT_MS - 1, now), true);
});
test("signInWithUsername maps any failure to the login message", async () => {
  // client palsu yang mengembalikan { error: { message: "Invalid login credentials" } } → { error: "Username atau password belum sesuai." }
  // username "a b" → pesan sama, client tidak dipanggil
  // sukses → { error: null }, dipanggil dengan { email: "9a_irfan@absensi-sholat.local", password: "absensi:123" }
});
```

- [ ] **Step 2: Ganti script `test` di `package.json` menjadi `"node --experimental-detect-module --test lib/auth.test.mjs"` (Task 6 menambahkan `lib/admin-students.test.mjs`), jalankan**

Run: `node --experimental-detect-module --test lib/auth.test.mjs`
Expected: FAIL, modul `lib/auth.js` tidak ditemukan.

- [ ] **Step 3: Implementasi `lib/auth.js`** sesuai Interfaces (ESM, tanpa import supabase; client dioper sebagai argumen).

- [ ] **Step 4: Jalankan tes**

Run: `node --experimental-detect-module --test lib/auth.test.mjs`
Expected: semua PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js lib/auth.test.mjs package.json
git commit -m "feat: add Supabase Auth account mapping helpers"
```

---

### Task 3: Migrasi Tahap 1 (aditif) + rollback + tes RPC

**Files:**
- Create: `supabase/migrations/20261030000000_auth_foundation.sql`, `supabase/rollback/20261030000000_auth_foundation.sql`, `supabase/tests/rpc.sql`

**Interfaces:**
- Produces (semua di schema `public`, `security definer`, `set search_path = ''`, execute dicabut dari `public, anon`, diberikan ke `authenticated`):
  - `is_admin() returns boolean`, `current_student_id() returns text` (keduanya `stable`)
  - `submit_attendance(p_status text) returns public.attendances`
  - `submit_late_attendance(p_date date, p_status text) returns public.attendances`
  - `admin_mark_attendance(p_student_id text, p_date date, p_status text) returns public.attendances`
  - `admin_delete_attendance(p_id text) returns void`
  - `admin_set_holiday(p_date date, p_is_holiday boolean) returns void`
  - `admin_set_prayer_schedule(p_enabled boolean, p_start time, p_end time, p_attendance_start_date date) returns public.prayer_schedule`
- Kolom baru: `students.auth_user_id`, `students.is_active`, `attendances.recorded_by`, `prayer_schedule.attendance_start_date`.

- [ ] **Step 1: Tulis `supabase/tests/rpc.sql`**

Satu transaksi `begin; ... rollback;` sebagai `postgres`. Fixture: tiga user di `auth.users` (`id, instance_id, aud, role, email`) — siswa perempuan aktif, siswa laki-laki aktif, siswa perempuan nonaktif — beserta baris `students` dengan `auth_user_id`; satu admin (claims `app_metadata.role = 'admin'`). Pindah aktor dengan:

```sql
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","app_metadata":{"role":"student"}}', true);
-- ... cek ...
reset role;
```

Pola cek gagal (satu blok per kasus):

```sql
do $$ begin
  perform public.submit_attendance('Hadir');
  raise exception 'EXPECTED FAILURE';
exception when others then
  if sqlerrm not like 'Konfirmasi sholat Dzuhur tersedia mulai pukul %' then raise; end if;
end $$;
```

Script mencetak `raise notice 'rpc.sql: ALL PASSED'` di akhir. Lewati tes jendela waktu (dengan notice) bila jam Jakarta 23 atau 00. Kasus:

| Nama | Aktor | Setup | Harapan |
|---|---|---|---|
| `submit_hadir_inside_window` | siswa P | jendela = sekarang ±1 jam | baris, `status='Hadir'`, `recorded_by` = uid |
| `returned_row_uses_server_date` | siswa P | sama | `date = (now() at time zone 'Asia/Jakarta')::date`, `time ~ '^\d{2}\.\d{2}$'`, `student_name`/`class_name` dari `students` |
| `submit_twice_returns_same_row` | siswa P | panggil 2x | `id` sama, `count(*) = 1` |
| `before_window_rejected` | siswa L | `start` = sekarang +1 jam | `E_BEFORE` dengan jam `HH.MM` |
| `after_window_rejected` | siswa L | `end` = sekarang −1 jam | `E_AFTER` |
| `disabled_schedule_allows_any_time` | siswa L | `enabled=false`, jendela lewat | sukses |
| `holiday_rejected` | siswa L | `holidays` hari ini | `E_HOLIDAY` |
| `haid_male_rejected` | siswa L | — | `E_HAID` |
| `invalid_status_rejected` | siswa P | `'Terlambat'` ke `submit_attendance` | `E_STATUS` |
| `inactive_student_rejected` | siswa nonaktif | — | `E_NO_STUDENT` |
| `late_ok` | siswa L | tanggal kemarin (bukan libur) | `status='Terlambat'` |
| `late_before_start_rejected` | siswa L | `2026-07-31` | `E_LATE_RANGE` |
| `late_today_and_future_rejected` | siswa L | hari ini, besok | `E_LATE_RANGE` |
| `late_existing_rejected` | siswa L | ulang `late_ok` | `E_LATE_EXISTS` |
| `late_holiday_rejected` | siswa L | kemarin lusa jadi libur | `E_HOLIDAY` |
| `admin_rpcs_reject_student` | siswa P | keempat RPC admin | `E_NOT_ADMIN` |
| `admin_mark_future_rejected` | admin | besok | `E_FUTURE` |
| `admin_mark_and_delete` | admin | tandai siswa L hari ini `Hadir`, lalu hapus | baris ada lalu hilang |
| `admin_set_holiday_toggle` | admin | `true` lalu `false` | baris `holidays` ada lalu hilang |
| `admin_set_schedule` | admin | `true, '11:00', '14:00', '2026-08-01'` | baris id 1 sesuai |
| `status_check_constraint` | postgres | insert langsung `status='Izin'` | error `attendances_status_check` |
| `delete_student_with_history_restricted` | postgres | delete siswa yang punya absen | error foreign key |

- [ ] **Step 2: Jalankan ke staging**

Run: `scripts/staging.sh psql -f supabase/tests/rpc.sql`
Expected: FAIL (fungsi `public.submit_attendance` tidak ada).

- [ ] **Step 3: Tulis migrasi `20261030000000_auth_foundation.sql`** (dibungkus `begin; ... commit;`):
  - Kolom dan index sesuai spec bagian 7: `auth_user_id uuid unique references auth.users(id) on delete set null`, `is_active boolean not null default true`, unique index `students_username_lower_idx on (lower(username))`, `recorded_by uuid`, `attendance_start_date date not null default '2026-08-01'`.
  - `attendances_status_check` dibuat `not valid` lalu `validate constraint`.
  - Ganti `attendances_student_id_fkey` ke `on delete restrict`.
  - Fungsi pembantu dan enam RPC sesuai Interfaces dan aturan spec bagian 9. Perbandingan jendela per menit: tolak bila menit sekarang < menit `start_time` atau > menit `end_time`. Jam di pesan memakai `to_char(start_time, 'HH24.MI')`. Insert `submit_attendance` memakai `on conflict (student_id, date) do nothing` lalu select baris yang ada.
  - Policy baru `to authenticated`: `students` (`is_admin() or auth_user_id = auth.uid()`), `attendances` (`is_admin() or student_id = current_student_id()`), `holidays` dan `prayer_schedule` (`true`), `sync_changes` (`is_admin()`). Nama policy diawali `auth: `.
  - `revoke all on public.projects, public.site_settings from anon, authenticated` di dalam blok `do` yang memeriksa `to_regclass` dulu.
  - Policy lama `public can ...` tidak disentuh.
  - Diakhiri `notify pgrst, 'reload schema';`.

- [ ] **Step 4: Terapkan dan jalankan tes**

Run: `scripts/staging.sh psql -f supabase/migrations/20261030000000_auth_foundation.sql && scripts/staging.sh psql -f supabase/tests/rpc.sql`
Expected: `NOTICE: rpc.sql: ALL PASSED`

- [ ] **Step 5: Tulis rollback dan uji bolak-balik**

Rollback menghapus semua yang dibuat Step 3 (policy `auth: *`, fungsi, constraint, index, kolom), mengembalikan foreign key `on delete cascade`, dan `grant all` ke `anon, authenticated` pada `projects`/`site_settings` bila ada.
Run: rollback → `select count(*) from pg_proc where proname = 'submit_attendance'` = `0` → terapkan ulang migrasi → `rpc.sql` lagi.
Expected: `0`, lalu `ALL PASSED`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261030000000_auth_foundation.sql supabase/rollback/20261030000000_auth_foundation.sql supabase/tests/rpc.sql
git commit -m "feat: add attendance RPCs and authenticated policies"
```

---

### Task 4: Migrasi Tahap 4 (tutup akses lama) + rollback + tes akses

Disiapkan dan dites sekarang di staging; baru diterapkan ke production di Task 14.

**Files:**
- Create: `supabase/migrations/20261030000100_close_public_access.sql`, `supabase/rollback/20261030000100_close_public_access.sql`, `supabase/tests/access.sql`

**Interfaces:**
- Consumes: semua objek Task 3.
- Produces: kolom `students.password_legacy` (rename dari `password`); `get_monthly_class_prayer_ranking` hanya untuk admin dan hanya menghitung siswa `is_active`.

- [ ] **Step 1: Tulis `supabase/tests/access.sql`** (fixture sama dengan `rpc.sql`, dalam `begin; ... rollback;`, akhiri `access.sql: ALL PASSED`):

| Nama | Aktor | Harapan |
|---|---|---|
| `anon_cannot_select_any_table` | `set local role anon` | select `students`, `attendances`, `holidays`, `prayer_schedule`, `sync_changes` → error `permission denied` |
| `anon_cannot_write` | anon | insert `holidays`, update `prayer_schedule`, delete `attendances` → `permission denied` |
| `anon_cannot_rank` | anon | `get_monthly_class_prayer_ranking('2026-10-01')` → `permission denied` |
| `student_sees_only_self` | siswa P | `select count(*) from students` = 1; `attendances` hanya miliknya |
| `student_cannot_read_password_legacy` | siswa P | `select password_legacy from students` → `permission denied` |
| `student_cannot_write_directly` | siswa P | insert `attendances`, update `students`, insert `holidays` → `permission denied` |
| `student_cannot_read_sync_changes` | siswa P | `count(*)` = 0 |
| `student_cannot_rank` | siswa P | ranking → `E_NOT_ADMIN` |
| `admin_reads_everything` | admin | `count(*)` `students`, `attendances`, `sync_changes` sama dengan saat sebagai postgres |
| `ranking_counts_active_only` | admin | `student_count` kelas fixture tidak menghitung siswa nonaktif |
| `sync_payload_has_no_password` | postgres | update nama siswa P → baris `sync_changes` terbaru tidak punya kunci `password` maupun `password_legacy` |
| `realtime_publication_trimmed` | postgres | `pg_publication_tables` untuk `supabase_realtime` hanya `sync_changes`, `prayer_schedule` |

- [ ] **Step 2: Jalankan; harapkan gagal**

Run: `scripts/staging.sh psql -f supabase/tests/access.sql`
Expected: FAIL di `anon_cannot_select_any_table`.

- [ ] **Step 3: Tulis migrasi `20261030000100_close_public_access.sql`** sesuai spec bagian 11 Tahap 4: drop 14 policy `public can ...` (daftar di `schema.sql:137-149` + `public can read sync changes`); `revoke all` dari `anon` di lima tabel aplikasi; `revoke insert, update, delete, truncate, references, trigger` dari `authenticated`; `revoke select on students from authenticated` lalu column grant (Global Constraints); `alter publication supabase_realtime drop table public.students, public.attendances, public.holidays`; `capture_sync_change` untuk `students` hanya menyimpan `id, nis, name, class_name, gender, username, is_active`; `delete from sync_changes where row_data ? 'password'`; rename `password` → `password_legacy` + `revoke all (password_legacy)`; ganti `get_monthly_class_prayer_ranking` (cek `is_admin()`, filter `is_active`, execute hanya `authenticated`).

- [ ] **Step 4: Terapkan dan jalankan kedua tes**

Run: `scripts/staging.sh psql -f supabase/migrations/20261030000100_close_public_access.sql && scripts/staging.sh psql -f supabase/tests/access.sql && scripts/staging.sh psql -f supabase/tests/rpc.sql`
Expected: `access.sql: ALL PASSED`, `rpc.sql: ALL PASSED`.

- [ ] **Step 5: Tulis rollback dan uji bolak-balik**

Rollback membuat ulang 14 policy lama persis seperti `schema.sql`, grant lama, publication, trigger lama, rename kolom kembali, ranking lama (grant `anon`).
Run: rollback → `scripts/staging.sh psql -A -t -c "select count(*) from pg_policies where policyname like 'public can%'"` → terapkan ulang migrasi → `access.sql`.
Expected: `14`, lalu `ALL PASSED`.

- [ ] **Step 6: Rollback lagi agar staging kembali ke kondisi Tahap 1** (dibutuhkan Task 10 untuk menguji urutan production).

Run: rollback Task 4 saja.
Expected: `rpc.sql: ALL PASSED`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261030000100_close_public_access.sql supabase/rollback/20261030000100_close_public_access.sql supabase/tests/access.sql
git commit -m "feat: add migration closing anonymous table access"
```

---

### Task 5: Script akun Auth (Tahap 2)

**Files:**
- Create: `scripts/migrate-auth-users.mjs`

**Interfaces:**
- Consumes: `usernameToEmail`, `toAuthPassword` dari `lib/auth.js`.
- Produces: CLI `node --env-file=<file> scripts/migrate-auth-users.mjs [--dry-run] [--sync] --confirm-ref=<ref>`. Env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
  - Tanpa `--confirm-ref` yang sama dengan ref di URL → exit 1 sebelum request apa pun. `--dry-run` tidak butuh `--confirm-ref`.
  - Membaca semua siswa (paging 1000, kolom `id, username, password, is_active, auth_user_id`; setelah Tahap 4 kolomnya `password_legacy` — deteksi otomatis lewat error kolom).
  - Membangun peta email → user dari `auth.admin.listUsers` (paging) sekali di awal.
  - Siswa tanpa `auth_user_id`: pakai user yang emailnya sudah ada, atau `createUser({ email, password: toAuthPassword(password), email_confirm: true, app_metadata: { role: "student", student_id } })`; lalu isi `auth_user_id`. Konkurensi 5.
  - `--sync`: untuk siswa yang sudah punya akun, `updateUserById(auth_user_id, { password: toAuthPassword(password) })`.
  - Akun `guru` dibuat bila belum ada, `app_metadata: { role: "admin" }`, password `crypto.randomBytes(18).toString("base64url")` dicetak sekali dengan label `PASSWORD GURU (simpan sekarang, tidak ditampilkan lagi):`. Bila sudah ada, tidak diubah.
  - Ringkasan akhir: `dibuat`, `ditautkan`, `disinkron`, `gagal` (dengan username dan pesan), exit 1 bila `gagal > 0`.

- [ ] **Step 1: Dry-run ke staging**

Run: `scripts/staging.sh run node scripts/migrate-auth-users.mjs --dry-run`
Expected: `akan dibuat: 40`, `guru: akan dibuat`, tanpa perubahan (`select count(*) from auth.users` = 0).

- [ ] **Step 2: Tanpa `--confirm-ref` ditolak**

Run: `scripts/staging.sh run node scripts/migrate-auth-users.mjs`
Expected: exit 1, pesan meminta `--confirm-ref`.

- [ ] **Step 3: Jalankan sungguhan, lalu ulangi (idempoten)**

Run: `scripts/staging.sh run node scripts/migrate-auth-users.mjs --confirm-ref=<ref staging>` dua kali.
Expected: run pertama `dibuat: 40`, password guru tercetak; run kedua `dibuat: 0`, `gagal: 0`. `select count(*) from students where auth_user_id is null` = 0.

- [ ] **Step 4: Uji `--sync` dan login**

Ubah password satu siswa di kolom `password` staging menjadi `456`, jalankan dengan `--sync`, lalu `signInWithUsername` (Task 2) dengan `456` berhasil dan dengan `123` gagal.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-auth-users.mjs
git commit -m "feat: add Supabase Auth user migration script"
```

---

### Task 6: API admin kelola siswa (server)

**Files:**
- Create: `lib/supabase-admin.js`, `lib/admin-auth.js`, `lib/admin-students.js`, `lib/admin-students.test.mjs`, `app/api/admin/students/route.js`, `app/api/admin/students/[id]/route.js`, `app/api/admin/students/[id]/password/route.js`, `app/api/admin/students/import/route.js`
- Modify: `.env.example` (tambah `SUPABASE_SERVICE_ROLE_KEY=` dengan komentar "server only")

**Interfaces:**
- Consumes: `usernameToEmail`, `toAuthPassword` (Task 2).
- Produces:
  - `lib/supabase-admin.js`: `getSupabaseAdmin(): SupabaseClient` (lazy, `persistSession: false`), file diawali `import "server-only"`.
  - `lib/admin-auth.js`: `requireAdmin(request: Request): Promise<{ user } | Response>` — tanpa/invalid Bearer → 401 `{ error: "Sesi tidak valid. Silakan login ulang." }`; bukan admin → 403 `{ error: E_NOT_ADMIN }`.
  - `lib/admin-students.js` (tidak meng-import `lib/supabase-admin.js`; operasi menerima client `admin` sebagai argumen, sehingga `app/page.js` aman meng-import `normalizeStudentName` dari sini):
    - `validateStudentInput(input, { requirePassword: boolean }): { value } | { error: string }` — `name` (dinormalisasi dengan `normalizeStudentName` yang dipindah dari `app/page.js` ke modul ini dan di-export) dan `className` wajib; `username` cocok `^[A-Za-z0-9._-]+$` dan bukan `guru` (case-insensitive); `gender` ∈ `Laki-laki`, `Perempuan`, kosong → `null`; `password` wajib bila `requirePassword`; `nis` string.
    - `STUDENT_COLUMNS = "id,nis,name,class_name,gender,username,is_active"`
    - `createStudent(admin, input)`, `updateStudent(admin, id, input)`, `deactivateStudent(admin, id)`, `resetStudentPassword(admin, id, password)`, `importStudents(admin, rows)`; semua mengembalikan `{ data } | { error, status }`.
  - Route (body/response JSON):
    - `POST /api/admin/students` body `{ nis, name, className, gender, username, password }` → 201 `{ student }`; username sudah dipakai (case-insensitive) → 409 `{ error: "Username sudah digunakan." }`.
    - `PATCH /api/admin/students/[id]` body tanpa `password` → 200 `{ student }`; username berubah → email Auth diubah dulu, dikembalikan bila update `students` gagal.
    - `DELETE /api/admin/students/[id]` → 200 `{ ok: true }`; `is_active=false` + `ban_duration: "876000h"`.
    - `POST /api/admin/students/[id]/password` body `{ password }` → 200 `{ ok: true }`.
    - `POST /api/admin/students/import` body `{ students: [...] }` maksimal 100 → 200 `{ results: [{ username, status: "created" | "duplicate" | "error", message? }] }`; lebih dari 100 → 400.
    - `createStudent`: buat user Auth (`app_metadata: { role: "student", student_id }`), lalu insert `students` dengan `auth_user_id`; bila insert gagal, `deleteUser`.

- [ ] **Step 1: Pasang dependency dan baca panduan Next 16**

Run: `npm ci`, lalu baca panduan route handler dan server-only di `node_modules/next/dist/docs/` (cari `route.js`, `params`, `server-only`). Catat di pesan commit Task ini: bentuk `params` (sinkron atau Promise) dan apakah `server-only` perlu di-install. Bila perlu: `npm install server-only`.

- [ ] **Step 2: Tulis tes `lib/admin-students.test.mjs`** untuk `validateStudentInput`:

```js
test("validateStudentInput requires name, class and a safe username", /* name kosong, className kosong, username "a b" → error */);
test("validateStudentInput reserves guru", () => {
  assert.ok(validateStudentInput({ name: "A", className: "9A", username: "GURU", password: "123" }, { requirePassword: true }).error);
});
test("validateStudentInput requires password only on create", /* tanpa password: requirePassword true → error, false → value */);
test("validateStudentInput normalizes name and gender", /* name "  siti AMINAH " → "Siti Aminah"; gender "" → null; gender "X" → error */);
```

- [ ] **Step 3: Tambahkan `lib/admin-students.test.mjs` ke script `test`; jalankan, harapkan gagal; implementasi `lib/admin-students.js` (validasi saja); jalankan lagi**

Run: `npm test`
Expected: FAIL lalu PASS.

- [ ] **Step 4: Implementasi `lib/supabase-admin.js`, `lib/admin-auth.js`, operasi di `lib/admin-students.js`, dan empat route.** Route hanya: `requireAdmin` → parse JSON → panggil operasi → `Response.json`.

- [ ] **Step 5: Verifikasi terhadap staging lewat dev server**

Run: `scripts/staging.sh run npx next dev -p 3001` (background). Ambil JWT guru dan siswa dengan `signInWithUsername` di script node kecil di scratchpad, lalu `curl`:

| Nama | Request | Expected |
|---|---|---|
| `no_token_rejected` | POST students tanpa header | 401 |
| `student_token_rejected` | POST students dengan JWT siswa | 403 |
| `create_student` | POST `{ name:"Uji Satu", className:"9A", username:"9A_Uji", password:"123", gender:"Perempuan" }` | 201; `signInWithUsername("9a_uji","123")` berhasil |
| `create_duplicate_case` | POST username `9a_uji` | 409 `Username sudah digunakan.` |
| `update_username` | PATCH username `9A_Uji2` | 200; login `9a_uji2`/`123` berhasil, `9a_uji` gagal |
| `reset_password` | POST password `789` | 200; login dengan `789` berhasil |
| `deactivate` | DELETE | 200; login gagal; `is_active=false` |
| `import_reports_case_insensitive_duplicate` | import 2 baris: `9a_irfan` (sudah ada sebagai `9A_Irfan`) dan `9B_Baru` | `duplicate` untuk `9a_irfan`, `created` untuk `9B_Baru` |
| `import_limit` | 101 baris | 400 |
| `bundle_has_no_service_key` | `npm run build` lalu `grep -r "sb_secret_\|SUPABASE_SERVICE_ROLE_KEY" .next/static` | tidak ada hasil |

- [ ] **Step 6: Commit**

```bash
git add lib/supabase-admin.js lib/admin-auth.js lib/admin-students.js lib/admin-students.test.mjs app/api/admin .env.example package.json package-lock.json
git commit -m "feat: add admin student management API"
```

---

### Task 7: `app/page.js` — alur login dan sesi

**Files:**
- Modify: `app/page.js` (state awal dan `loadData` 478-584, `login` 1003-1026, `changePassword` 1028-1050, logout di 1406 dan 1467, `mapStudent` 184-194, `initialStudents` 34-81)
- Create: `lib/api.js` (bagian akun)

**Interfaces:**
- Consumes: `signInWithUsername`, `migrateLegacySession`, `usernameToEmail`, `toAuthPassword`, `ADMIN_ACTIVITY_KEY`, `isAdminSessionExpired` (Task 2).
- Produces:
  - `lib/api.js`: `fetchOwnStudentProfile(userId: string): Promise<{ data, error }>` (select `id,nis,name,class_name,gender,username,is_active` `.eq("auth_user_id", userId).maybeSingle()`), `changeOwnPassword(username, currentPassword, newPassword): Promise<string | null>` (null = sukses, selain itu pesan error; password lama salah → `Password saat ini tidak sesuai.`).
  - `mapStudent(item)` tanpa `password`, dengan `isActive: item.is_active !== false`.
  - State `user`: admin `{ role: "admin", name: "Guru Admin", username: "guru" }`; siswa `{ ...mapStudent(row), role: "student" }`.

- [ ] **Step 1: Ganti pemulihan sesi.** Saat mount: `await migrateLegacySession(localStorage, (u, p) => signInWithUsername(supabase, u, p).then((r) => !r.error))`, lalu `supabase.auth.getSession()` dan `supabase.auth.onAuthStateChange`. Dari sesi: role dari `session.user.app_metadata.role`; siswa → `fetchOwnStudentProfile`; profil tidak ada/nonaktif → `signOut()` + notice `E_NO_STUDENT`. Tanpa sesi → halaman login.

- [ ] **Step 2: Hapus pengambilan siswa sebelum login.** Daftar siswa (`fetchAllSupabaseRows("students", "id,nis,name,class_name,gender,username,is_active")`) hanya dimuat setelah user admin terautentikasi. Hapus `teacherPassword` dan semua cabang `if (!supabase)` beserta `initialStudents`.

- [ ] **Step 3: Ganti `login`, `changePassword`, dan logout.** `login` → `signInWithUsername`; error tampil di `notice`. Logout → `supabase.auth.signOut()` + hapus `dzuhur-cache-v3` dan `ADMIN_ACTIVITY_KEY`.

- [ ] **Step 4: Timeout admin.** Saat sesi admin dipulihkan: `isAdminSessionExpired(Number(localStorage.getItem(ADMIN_ACTIVITY_KEY)) || null, Date.now())` → `signOut()`. Perbarui key saat login dan pada `pointerdown`/`keydown` (paling sering sekali per menit).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: sukses tanpa error.

- [ ] **Step 6: Verifikasi manual terhadap staging** (`scripts/staging.sh run npx next dev -p 3001`, browser):
  - Halaman login: tab Network tidak berisi request ke `/rest/v1/students` sebelum login.
  - Login `9A_Irfan`/`123` dan ` 9a_irfan `/`123` → halaman siswa; password salah → `E_LOGIN`.
  - Set `localStorage["dzuhur-session"] = '{"role":"admin","name":"x"}'`, reload → halaman login, key terhapus.
  - Set sesi siswa lama `{"role":"student","username":"9A_Ahmad","password":"123", ...}` tanpa sesi Supabase, reload → masuk sebagai Ahmad, semua `LEGACY_STORAGE_KEYS` terhapus.
  - Login guru (password dari Task 5) → dashboard; ganti password guru lalu login ulang dengan password baru.
  - Nonaktifkan siswa lewat API saat siswa itu masih login, lalu reload siswa → halaman login dengan `E_NO_STUDENT` (setelah token kedaluwarsa atau refresh ditolak).
  - Set `ADMIN_ACTIVITY_KEY` ke 8 hari lalu, reload → halaman login.

- [ ] **Step 7: Commit**

```bash
git add app/page.js lib/api.js
git commit -m "feat: authenticate students and teachers with Supabase Auth"
```

---

### Task 8: `app/page.js` — absensi, libur, jadwal, realtime, cache

**Files:**
- Modify: `app/page.js` (`fetchPrayerSchedule` 299-313, `recordAttendance` 1073-1118, `toggleHoliday` 1132-1151, `markStudentForDate`/`markStudentPresent`/`markStudentMenstruation` 1153-1274, `confirmCancelAttendance` 1352-1367, `savePrayerSchedule` 1052-1071, efek realtime 585-621 dan 704-886, cache 83-84 dan 274-292 dan 652-670, `StudentSettingsPage` 1914-2000, `SettingsPage` 3425-3530)
- Modify: `lib/api.js`

**Interfaces:**
- Consumes: RPC Task 3.
- Produces (`lib/api.js`, semua `Promise<{ data, error: string | null }>`; `error` = `error.message` dari Supabase): `submitAttendance(status)`, `submitLateAttendance(date, status)`, `adminMarkAttendance(studentId, date, status)`, `adminDeleteAttendance(id)`, `adminSetHoliday(date, isHoliday)`, `adminSetPrayerSchedule({ enabled, start, end, attendanceStartDate })`.
- `prayerSchedule` state bertambah `attendanceStartDate` (`"YYYY-MM-DD"`).

- [ ] **Step 1: Ganti penulisan.** `recordAttendance(status, date)`: `date === todayKey` → `submitAttendance`, selain itu `submitLateAttendance`; sukses → `upsertAttendanceSlices(mapAttendance(data))` (memakai baris server, bukan record buatan client); gagal → `setAttendanceNotice(error)`. Tiga fungsi tandai admin → `adminMarkAttendance`; batal → `adminDeleteAttendance`; libur → `adminSetHoliday(todayKey, !isHoliday)`; jadwal → `adminSetPrayerSchedule`. Pengecekan di client tetap ada.

- [ ] **Step 2: Tanggal mulai absensi.** `fetchPrayerSchedule` menyelect `attendance_start_date`. `SettingsPage` mendapat input `type="date"` berlabel "Tanggal mulai absensi". `StudentSettingsPage` menerima `attendanceStartDate`; `canCorrect` ditambah `date >= attendanceStartDate`.

- [ ] **Step 3: Realtime hanya admin.** Channel `prayer-schedule-sync` dan `absensi-sync-*` hanya dibuat bila `user?.role === "admin"`. Siswa: ambil ulang absensi sendiri (`fetchAttendanceRows({ studentId })`), `holidays`, dan jadwal saat mount dan pada event `focus`.

- [ ] **Step 4: Cache admin.** `REMOTE_CACHE_KEY = "dzuhur-cache-v3"`; dibaca dan ditulis hanya saat `user?.role === "admin"`; tidak berisi password.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: sukses.

- [ ] **Step 6: Verifikasi manual terhadap staging** (dua browser: guru dan siswa):
  - Siswa absen di dalam jendela → tercatat; jam di UI sama dengan kolom `time` di DB.
  - Atur jendela lewat (guru) → siswa absen → modal "Absensi gagal disimpan" berisi `E_AFTER`.
  - Siswa perempuan "Haid" → tercatat; dobel klik cepat → satu baris.
  - Koreksi kemarin → `Terlambat`; tanggal sebelum `attendance_start_date` tidak bisa dipilih.
  - Guru tandai, batalkan, set libur → dashboard guru di browser lain berubah tanpa reload (realtime).
  - Siswa: tidak ada WebSocket realtime di tab Network; guru set libur → siswa melihatnya setelah fokus ulang tab.
  - Rekap bulanan, ranking, export xlsx, halaman QR → jalan seperti di master.
  - Ubah jam Mac ke 23.59 WIB, buka halaman siswa, tunggu lewat 00.00, absen → tanggal tersimpan = tanggal server, UI menampilkan baris itu.

- [ ] **Step 7: Commit**

```bash
git add app/page.js lib/api.js
git commit -m "feat: write attendance through server-validated RPCs"
```

---

### Task 9: `app/page.js` — UI kelola siswa dan import

**Files:**
- Modify: `app/page.js` (`saveStudent` 1276-1334, `confirmDelete` 1340-1346, `Students` 3101-3312 termasuk `confirmImport` 3162-3222 dan tabel 3259-3299, `StudentModal` 3595-3650, `DeleteConfirm` 3652-3683)
- Modify: `lib/api.js`

**Interfaces:**
- Consumes: route Task 6.
- Produces (`lib/api.js`): `adminFetch(path, { method, body }): Promise<{ data, error: string | null }>` (menyertakan `Authorization: Bearer <access_token>` dari `supabase.auth.getSession()`), `createStudent(input)`, `updateStudent(id, input)`, `deactivateStudent(id)`, `resetStudentPassword(id, password)`, `importStudents(rows)`.

- [ ] **Step 1: Tabel siswa.** Kolom "Password" diganti tombol "Reset password" yang membuka `ResetPasswordModal` baru (field password baru + konfirmasi; tidak sama → `Konfirmasi password belum sesuai.`). Siswa `isActive === false` disembunyikan.

- [ ] **Step 2: Form siswa.** `StudentModal`: field Password hanya saat tambah (default `123`). `saveStudent` → `createStudent`/`updateStudent`; error tampil di `notice`; sukses → `upsertById` dengan `mapStudent(data.student)`.

- [ ] **Step 3: Nonaktifkan.** Ikon dan `DeleteConfirm` memakai teks "Nonaktifkan murid" dan menjelaskan riwayat absensi tetap tersimpan. `confirmDelete` → `deactivateStudent`; error tidak lagi diabaikan.

- [ ] **Step 4: Import.** `confirmImport` mengirim `preview.students` per 100 lewat `importStudents`, menampilkan `Mengimpor X dari Y murid...`, mengumpulkan hasil; ada `error` → tampilkan daftar username gagal di preview; selesai tanpa error → `window.location.reload()` seperti sekarang.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: sukses.

- [ ] **Step 6: Verifikasi manual terhadap staging:** tambah, edit, reset password, nonaktifkan (login siswa itu gagal setelahnya), import file 150 baris buatan (2 batch, 1 username bentrok beda huruf → dilaporkan duplikat), daftar siswa tidak menampilkan password di mana pun (cari "123" di DOM dan di `localStorage`).

- [ ] **Step 7: Commit**

```bash
git add app/page.js lib/api.js
git commit -m "feat: manage student accounts through admin API"
```

---

### Task 10: Verifikasi end-to-end staging dan Preview

**Files:**
- Create: `scripts/verify-security.mjs`, `docs/superpowers/evidence/staging-after.md`

**Interfaces:**
- Produces: `node scripts/verify-security.mjs --phase=before|after [--read-only] [--student=<username>:<password>]`. `--read-only` melewati semua cek tulis (dipakai di production sebelum Tahap 4). Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Mencetak satu baris `PASS|FAIL <nama>` per cek, exit 1 bila ada FAIL. Tidak pernah mencetak isi baris data, hanya status dan jumlah.
  - Cek anon (REST): select kelima tabel; insert `holidays` `1900-01-01`; update `prayer_schedule`; delete `attendances?id=eq.__tidak_ada__`; rpc ranking. `before` = diizinkan, `after` = ditolak (401/403/42501 atau 0 baris untuk select). Bila insert `1900-01-01` ternyata berhasil di mode `after`: hapus barisnya, cetak FAIL.
  - Cek anon realtime: subscribe `postgres_changes` `sync_changes` 10 detik; `after` = tidak ada event (pemicu: `--trigger-with-service-role`, hanya dipakai di staging).
  - Dengan `--student`: login, select `students` (harus 1 baris tanpa `password`), insert langsung `attendances` (ditolak), rpc ranking (ditolak).

- [ ] **Step 1: Implementasi script, jalankan mode `before` ke staging (kondisi Tahap 1)**

Run: `scripts/staging.sh run node scripts/verify-security.mjs --phase=before`
Expected: semua PASS (akses lama masih terbuka).

- [ ] **Step 2: App lama tetap jalan di Tahap 1–2.** `git worktree add ../absensi-master master`, jalankan `scripts/staging.sh run npx next dev -p 3002` di worktree itu: login siswa `123`, absen, guru tandai → berhasil. Catat efek yang diketahui: hapus siswa yang punya riwayat di app lama sekarang gagal di DB (foreign key `restrict`), sementara UI lama tetap menghapusnya dari layar.

- [ ] **Step 3: Terapkan Tahap 4 ke staging, jalankan semua tes**

Run: migrasi Task 4 → `access.sql` → `rpc.sql` → `scripts/staging.sh run node scripts/verify-security.mjs --phase=after --student=9A_Irfan:123 --trigger-with-service-role`
Expected: semua PASS.

- [ ] **Step 4: Ulangi checklist manual Task 7–9 singkat di app baru (Tahap 4 aktif).** Tulis hasil Step 1–4 ke `docs/superpowers/evidence/staging-after.md` (perintah, PASS/FAIL, tanpa secret).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-security.mjs docs/superpowers/evidence/staging-after.md
git commit -m "test: add security verification script and staging evidence"
```

- [ ] **Step 6: STOP — minta konfirmasi push branch.** Setelah disetujui: `git push -u origin security/supabase-auth`, buat PR (skill `pr`). Minta pemilik mengisi env **Preview** Vercel dengan nilai staging (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Pemilik menguji URL Preview dari HP: login siswa, absen, Haid, koreksi, ganti password, login guru, dashboard realtime.

---

### Task 11: Production Tahap 0 dan Tahap 1

- [ ] **Step 1: STOP — minta konfirmasi pemilik untuk memulai production.**
- [ ] **Step 2: Backup.** Pemilik menjalankan `pg_dump "<URL production>" --schema=public --schema=auth -Fc -f backup-sebelum-auth.dump` dan menyimpan file di luar repo.
- [ ] **Step 3: Cek read-only (pemilik menjalankan di SQL Editor):** `select status, count(*) from attendances group by 1;` (hanya `Hadir`, `Terlambat`, `Haid`), `select time from attendances order by created_at desc limit 5;` (format `HH.MM`), `select conname from pg_constraint where conrelid = 'public.attendances'::regclass and contype = 'f';` (`attendances_student_id_fkey`). Catat rate limit sign-in di Authentication → Rate Limits. Matikan "Allow new users to sign up".
- [ ] **Step 4: STOP — konfirmasi menjalankan migrasi Tahap 1.** Pemilik menempel `supabase/migrations/20261030000000_auth_foundation.sql` ke SQL Editor production dan menjalankan.
- [ ] **Step 5: Verifikasi.** `select count(*) from pg_proc where proname in ('submit_attendance','submit_late_attendance','admin_mark_attendance','admin_delete_attendance','admin_set_holiday','admin_set_prayer_schedule')` = 6. Pemilik membuka app production (masih versi lama): login siswa, absen, dashboard guru jalan. Catat di `docs/superpowers/evidence/production.md`.
- [ ] **Rollback bila gagal:** jalankan `supabase/rollback/20261030000000_auth_foundation.sql`.

### Task 12: Production Tahap 2

- [ ] **Step 1: STOP — konfirmasi.** Pemilik membuat `.env.production.local` (di-gitignore) berisi URL dan service role production.
- [ ] **Step 2:** `node --env-file=.env.production.local scripts/migrate-auth-users.mjs --dry-run` → `akan dibuat: <jumlah siswa>`.
- [ ] **Step 3:** Pemilik menjalankan dengan `--confirm-ref=<ref production>` di terminalnya sendiri (password guru hanya tampil di sana) dan menyimpan password guru.
- [ ] **Step 4: Verifikasi:** `select count(*) from students where auth_user_id is null` = 0; login contoh 3 siswa lewat `signInWithUsername` berhasil. Catat di evidence.
- [ ] **Rollback:** hapus user Auth dengan `app_metadata.role = 'student'` lewat admin API, `update students set auth_user_id = null`.

### Task 13: Production Tahap 3 (deploy)

- [ ] **Step 1: STOP — konfirmasi waktu deploy** (Jumat sore atau akhir pekan).
- [ ] **Step 2:** Pemilik mengisi `SUPABASE_SERVICE_ROLE_KEY` di env **Production** Vercel.
- [ ] **Step 3:** Jalankan script Tahap 2 tanpa flag lalu dengan `--sync` (production, konfirmasi ref).
- [ ] **Step 4: STOP — konfirmasi merge PR.** Merge; tunggu deploy Vercel selesai.
- [ ] **Step 5: Verifikasi:** checklist manual Task 7–9 di production dengan akun siswa uji dan guru; `node --env-file=.env.local scripts/verify-security.mjs --phase=before --read-only` masih PASS (akses lama belum ditutup). Pantau log Supabase (Auth dan Postgres) di jam dzuhur pertama. Catat di evidence.
- [ ] **Rollback:** Instant Rollback di Vercel ke deployment sebelumnya.

### Task 14: Production Tahap 4 (minimal 3 hari sekolah setelah Task 13 stabil)

- [ ] **Step 1: STOP — konfirmasi.**
- [ ] **Step 2:** Pemilik menjalankan `supabase/migrations/20261030000100_close_public_access.sql` di SQL Editor production.
- [ ] **Step 3: Verifikasi:** `node --env-file=.env.local scripts/verify-security.mjs --phase=after --student=<akun uji>:<password>` → semua PASS (tanpa `--trigger-with-service-role`). Pemilik mengecek login, absen, dan dashboard guru. Catat di evidence.
- [ ] **Rollback:** `supabase/rollback/20261030000100_close_public_access.sql`.

### Task 15: Production Tahap 5 (minimal 2 minggu setelah Task 14)

**Files:**
- Create: `supabase/migrations/20261030000200_drop_legacy_password.sql`
- Modify: `supabase/schema.sql` (mencerminkan kondisi akhir: kolom, policy, RPC, publication), `deploy/README.md` (tandai usang; produksi di Vercel), `scripts/migrate-auth-users.mjs` (hapus dukungan kolom password)

- [ ] **Step 1:** Tulis migrasi (`alter table public.students drop column password_legacy;`), perbarui `schema.sql`, lalu uji di staging: database staging dikosongkan, `schema.sql` baru dijalankan, `rpc.sql` dan `access.sql` PASS.
- [ ] **Step 2: Commit dan STOP — konfirmasi push/PR dan menjalankan migrasi di production.**
- [ ] **Step 3:** Setelah dijalankan: `verify-security.mjs --phase=after` PASS. Sarankan pemilik menghapus dump lama berisi password plaintext (`supabase-backup/`, `backup-sebelum-auth.dump`) setelah backup baru dibuat.
