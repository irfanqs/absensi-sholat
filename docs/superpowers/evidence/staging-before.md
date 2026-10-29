# Staging evidence: before hardening

Target: staging Supabase project only. Anon access with publishable key as `$KEY`. No keys or row contents recorded; only HTTP status and counts.

## Read students (including password column)

```bash
curl -s -o out.json -w '%{http_code}' -H "apikey: $KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/students?select=username,password&limit=2"
```

Result: HTTP 200, 2 rows, columns `username,password`. Plaintext passwords are readable by anon.

## Insert holiday (anon write)

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST -H "apikey: $KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d '{"date":"1900-01-01"}' "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/holidays"
```

Result: HTTP 201.

## Delete holiday (anon write)

```bash
curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "apikey: $KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/holidays?date=eq.1900-01-01"
```

Result: HTTP 204. Holidays table count afterwards: 0.

## Auth spike

`auth.admin.createUser` with email `spike_test@absensi-sholat.local` and password `absensi:123`: ok. `signInWithPassword` with publishable key: ok (session returned). `auth.admin.deleteUser`: ok. `auth.users` count afterwards: 0.
Note: on Node 20 supabase-js needs `--experimental-websocket`.
