# Staging evidence: Tahap 1 and Tahap 4

Target: staging Supabase project only (`scripts/staging.sh` refuses the production ref). Date: 2026-10-30. No keys, passwords or row contents recorded; only HTTP status, error codes and counts.

All node commands run on Node 20 as:

```bash
scripts/staging.sh run node --experimental-websocket \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON <script> [args]
```

Below, `VERIFY` stands for that prefix plus `scripts/verify-security.mjs`. The transcripts are from the final run of the committed script: Tahap 4 was applied, rolled back to the Tahap 1 state for section 1, then re-applied for section 2. Data at the start: 40 active students, 0 attendances, 0 holidays.

## 1. Tahap 1 state: old access still open

```bash
VERIFY --phase=before
```

```
PASS anon select students allowed (200, 40 rows, password column readable)
PASS anon select attendances allowed (200, 0 rows)
PASS anon select holidays allowed (200, 0 rows)
PASS anon select prayer_schedule allowed (200, 1 rows)
PASS anon select sync_changes allowed (200, 60 rows)
PASS anon rpc get_monthly_class_prayer_ranking allowed (200, 4 rows)
PASS anon insert holidays 1900-01-01 allowed (201)
PASS anon delete holidays 1900-01-01 allowed (200, 1 rows; remaining 0)
PASS anon insert attendances (old payload, Hadir) allowed (201)
PASS anon delete attendances (old app cancel) allowed (200, 1 rows; remaining 0)
PASS anon update prayer_schedule allowed (200, 1 rows)
PASS anon restore prayer_schedule (200, 1 rows)
PASS anon delete attendances id=__tidak_ada__ allowed (204)
PASS anon realtime sync_changes 10s receives row data (SUBSCRIBED, 2 events with row data, 0 empty "401 Unauthorized" notices, trigger: anon holiday insert + delete)
ALL PASS
```

```bash
VERIFY --phase=before --read-only
```

```
PASS anon select students allowed (200, 40 rows, password column readable)
PASS anon select attendances allowed (200, 0 rows)
PASS anon select holidays allowed (200, 0 rows)
PASS anon select prayer_schedule allowed (200, 1 rows)
PASS anon select sync_changes allowed (200, 66 rows)
PASS anon rpc get_monthly_class_prayer_ranking allowed (200, 4 rows)
# write checks skipped (--read-only)
PASS anon realtime sync_changes 10s subscribes (passive, no trigger) (SUBSCRIBED, 0 events with row data, 0 empty "401 Unauthorized" notices, trigger: none (passive))
ALL PASS
```

`VERIFY --phase=before --student=9A_Irfan:123 --trigger-with-service-role`: ALL PASS. It runs the same 13 anon checks as above, plus `student login`, `student select own profile (auth_user_id) (200, 1 rows)`, `service-role trigger wrote sync_changes rows (2 rows)` and `anon realtime ... receives row data (2 events with row data)`. The script refuses `--read-only --trigger-with-service-role` and an invalid `--phase` with exit 2.

### Old app replay at Tahap 1

Instead of running the old app in a browser, its anon Supabase calls (from `master:app/page.js`) were replayed against staging. `--phase=before` covers:

- student load with the old column list including `password` (the old login source);
- attendance list, holidays, schedule, and the `sync_changes` catch-up columns;
- the ranking RPC;
- the `recordAttendance` insert (old payload, status `Hadir`) and the cancel delete;
- holiday insert and delete;
- the `savePrayerSchedule` update: end time changed by one minute, then restored and read back.

Realtime: anon receives `sync_changes` INSERTs with row data. Afterwards staging data was unchanged. The only trace is new `sync_changes` log rows.

The old app's student-management effects were replayed as the `anon` role in one rolled-back transaction (workspace helper `t10-old-app-effects.sql`, not in the repo):

```
PASS old-app delete of student with history fails (23503 foreign_key_violation)
PASS old-app insert of case-variant username fails (23505 unique_violation)
PASS old-app add student works (row active, auth_user_id null: no new-app login until migrate-auth-users runs)
```

Afterwards: 0 attendances, 0 holidays.

### Negative control: `--phase=after` at Tahap 1

`VERIFY --phase=after --student=9A_Irfan:123 --trigger-with-service-role` returned 14 FAIL, exit 1. The two writes that succeeded were deleted by the script: `anon insert holidays 1900-01-01 rejected (201 — insert SUCCEEDED, deleted)` and `student direct insert attendances rejected (201 — insert SUCCEEDED, deleted)`. Afterwards there were 0 attendances and 0 holidays, and the schedule was unchanged. The selects on `attendances` and `holidays` pass by the "0 rows" rule because those staging tables are empty. On production they are not empty.

## 2. Tahap 4 applied

```bash
scripts/staging.sh psql -f supabase/migrations/20261030000100_close_public_access.sql   # ok
scripts/staging.sh psql -f supabase/tests/access.sql    # access.sql: ALL PASSED
scripts/staging.sh psql -f supabase/tests/rpc.sql       # rpc.sql: ALL PASSED
npm test                                                # tests 18, pass 18, fail 0
VERIFY --phase=after --student=9A_Irfan:123 --trigger-with-service-role
```

```
PASS anon select students rejected (401, 42501)
PASS anon select attendances rejected (401, 42501)
PASS anon select holidays rejected (401, 42501)
PASS anon select prayer_schedule rejected (401, 42501)
PASS anon select sync_changes rejected (401, 42501)
PASS anon rpc get_monthly_class_prayer_ranking rejected (401, 42501)
PASS anon insert holidays 1900-01-01 rejected (401, 42501)
PASS anon insert attendances rejected (401, 42501)
PASS anon update prayer_schedule rejected (401, 42501)
PASS anon delete attendances id=__tidak_ada__ rejected (401, 42501)
PASS student login (signed in)
PASS student select own profile (auth_user_id) (200, 1 rows)
PASS student select students returns only own row (200, 1 rows)
PASS student cannot read credential columns (password: 400, 42703; password_legacy: 403, 42501; *: 403, 42501)
PASS student direct insert attendances rejected (403, 42501)
PASS student rpc get_monthly_class_prayer_ranking rejected (400, P0001)
PASS service-role trigger wrote sync_changes rows (2 rows)
PASS anon realtime sync_changes 10s receives no row data (SUBSCRIBED, 0 events with row data, 2 empty "401 Unauthorized" notices, trigger: service role)
PASS student realtime sync_changes 10s receives no row data (SUBSCRIBED, 0 events with row data, 0 empty "401 Unauthorized" notices, trigger: service role)
ALL PASS
```

`VERIFY --phase=after --read-only`: ALL PASS. That is the 6 select and RPC rejections plus `anon realtime ... receives no row data`, with passive listening.

Negative control: `VERIFY --phase=before` with Tahap 4 applied returns 12 FAIL, exit 1.

### Realtime and anon

After Tahap 4, Supabase Realtime still sends anon one notice per `sync_changes` insert. Each notice has `errors: ["Error 401: Unauthorized"]` and empty `new` and `old` objects (0 keys). It carries only the table name, the event type and the commit time, never row data. So the check asserts "no row data" and reports how many of these notices arrived. The student role has SELECT, and RLS denies the rows, so the student receives nothing at all.

### New app smoke test (Tahap 4, through `lib/api.js`)

The workspace helper `t10-smoke.mjs` (not in the repo) uses the `lib/api.js` wrappers and the shared `lib/supabase.js` client, plus two separate realtime clients (guru and student). The guru channel uses the dashboard filter `record_date=eq.<today>`. It ran ALL PASS three times: on the first apply, after the first rollback round trip, and on the final state. Final run:

```
PASS realtime subscribed (guru, student) (SUBSCRIBED/SUBSCRIBED)
PASS guru adminSetPrayerSchedule (open window around now)
PASS student fetchOwnStudentProfile (1 row, no password key)
PASS student submitAttendance('Hadir') (row returned)
PASS student sees only own attendance (1 rows)
PASS guru list students (named columns) (40 rows)
PASS guru select * on students rejected (column grant) (42501)
PASS guru ranking RPC (4 rows)
PASS guru adminMarkAttendance (other student, today) (row returned)
PASS guru realtime receives sync_changes INSERTs with row data (2 data events, 0 empty notices)
PASS student realtime receives nothing (0 data events, 0 empty notices)
PASS cleanup adminDeleteAttendance
PASS cleanup adminDeleteAttendance
PASS restore schedule
PASS schedule equals original
PASS no attendance rows left (0)
ALL PASS
```

### migrate-auth-users dry run with Tahap 4 applied

```bash
scripts/staging.sh run node --experimental-websocket \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/migrate-auth-users.mjs --dry-run
```

`students.password` no longer exists (42703 above), so the script read `password_legacy`. Result: siswa 40, akan dibuat 0, akan ditautkan 0, akan disinkron 0, guru sudah ada, gagal 0. Exit 0.

## 3. Staging end state

Tahap 4 is APPLIED, which matches production after Task 14:

| Item | Value |
| --- | --- |
| students active / inactive | 40 / 0 |
| students with an Auth user | 40 (plus the guru Auth user) |
| attendances | 0 |
| holidays | 0 |
| prayer_schedule | enabled, 11:30–15:00, start date 2026-08-01 |
| "public can ..." policies | 0 |
| "auth: ..." policies | 5 |
| credential column | `password_legacy` only |
| realtime publication | `prayer_schedule`, `sync_changes` |
| sync_changes rows containing a password | 0 |

## Known old-app effects during Tahap 1–3

These apply while the old app is still deployed: between Tahap 1 and the new app going live, and after any Instant Rollback to the old app before Tahap 4.

- Deleting a student who has attendance history fails in the database (foreign key `on delete restrict`). The old UI ignores the error and removes the student from the screen. The student reappears after a reload.
- Adding or importing a student fails when the username differs from an existing one only by letter case (`students_username_lower_idx`). A single add shows the raw duplicate error. An import silently skips the row.
- A student added in the old app has no Auth user (`auth_user_id` null). They cannot log in to the new app until `scripts/migrate-auth-users.mjs` is run for them.
- A password changed in the old app updates only `students.password`. The Auth password stays the same. Do not use `migrate-auth-users --sync` after the new app is live, because it would overwrite passwords changed in the new app.
- After Tahap 4 the old app can no longer read or write anything.
