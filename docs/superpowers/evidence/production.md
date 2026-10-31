# Production evidence

Project ref: `btdaakqkjrneztjnbzan`. No secrets are recorded here.

## Tahap 0 — 2026-10-31

- Backup: `backup-sebelum-auth-20261031-1914.dump` (pg_dump custom, 1.9 MB, schemas `public` and `auth`), kept on the owner's Mac outside the repo. `pg_restore` reads it; it holds `students` 1166 rows, `attendances` 18946 rows, `holidays` 0 rows, plus `prayer_schedule` and `auth.users`.
- Read-only checks (SQL Editor):
  - `attendances.status`: Hadir 12107, Terlambat 4119, Haid 2720 (total 18946, matches the dump).
  - Latest `attendances.time` values use `HH.MM` (`13.46`, `12.57`, `12.54`).
  - Foreign key: `attendances_student_id_fkey`.
  - Usernames duplicated case-insensitively: none.
  - `auth.users`: 0.
- Preview deployment of PR #2 against staging: owner ran `manual-checklist.md`; all passed after the UI fixes in `79a0db1` and `7bbc9fe`.

## Tahap 1 — 2026-10-31

- Owner ran `supabase/migrations/20261030000000_auth_foundation.sql` in the SQL Editor outside 11:00–15:30 WIB.
- Verified by the owner: 6 new RPCs, the 4 new columns, 1166 active students; the old app still logs in, records attendance and shows the teacher dashboard.

## Tahap 2 — 2026-10-31

- `migrate-auth-users --dry-run`: `siswa: 1166`, `akan dibuat: 1166`, `akan ditautkan: 0`, `akan disinkron: 0`, `guru: akan dibuat`, `gagal: 0`.
- `migrate-auth-users --confirm-ref=btdaakqkjrneztjnbzan`: `dibuat: 1166`, `ditautkan: 0`, `disinkron: 0`, `guru: dibuat`, `gagal: 0`. The owner stored the new guru password.
- `students where auth_user_id is null`: 0. `auth.users`: 1167.
- `supabase/checks/auth_integrity.sql`: 0 rows.
- Sample `signInWithUsername` logins against production (several students and `guru`): all OK.
