// Menghapus semua murid uji checklist manual (username berawalan t9_) beserta absensi
// dan akun Auth-nya. HANYA untuk staging / database Preview, jangan production.
//
// Jalankan dari root repo lewat wrapper staging (menolak ref production):
//   scripts/staging.sh run node --experimental-websocket \
//     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     docs/superpowers/evidence/fixtures/cleanup-test-students.mjs --confirm-ref=<ref staging>
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. --confirm-ref wajib sama dengan
// ref di NEXT_PUBLIC_SUPABASE_URL. Mencetak hanya jumlah, tidak pernah isi baris.
// Absensi murid uji dihapus lebih dulu karena foreign key attendances -> students
// memakai on delete restrict.
import { createClient } from "@supabase/supabase-js";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim())?.[1];
const confirm = process.argv.slice(2).find((arg) => arg.startsWith("--confirm-ref="));
if (!ref || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail("NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.");
}
if (confirm !== `--confirm-ref=${ref}`) {
  fail("Ditolak: tambahkan --confirm-ref=<ref staging> yang sama dengan ref di NEXT_PUBLIC_SUPABASE_URL.");
}

const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: rows, error } = await service
  .from("students")
  .select("id,auth_user_id")
  .ilike("username", "t9\\_%");
if (error) fail(`Gagal membaca students: ${error.message}`);
const ids = rows.map((row) => row.id);

let attendances = 0;
if (ids.length) {
  const deleted = await service.from("attendances").delete({ count: "exact" }).in("student_id", ids);
  if (deleted.error) fail(`Gagal menghapus absensi uji: ${deleted.error.message}`);
  attendances = deleted.count ?? 0;
  for (const row of rows) {
    if (!row.auth_user_id) continue;
    const { error: authError } = await service.auth.admin.deleteUser(row.auth_user_id);
    if (authError) fail(`Gagal menghapus akun Auth uji: ${authError.message}`);
  }
  const removed = await service.from("students").delete().in("id", ids);
  if (removed.error) fail(`Gagal menghapus murid uji: ${removed.error.message}`);
}

const { data: users, error: listError } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) fail(`Gagal membaca akun Auth: ${listError.message}`);
const orphans = users.users.filter((user) => (user.email || "").startsWith("t9_"));
for (const user of orphans) await service.auth.admin.deleteUser(user.id);

const { count } = await service
  .from("students")
  .select("id", { count: "exact", head: true })
  .eq("is_active", true);
console.log(
  `dihapus: ${ids.length} murid uji, ${attendances} absensi uji, ${orphans.length} akun Auth yatim; murid aktif sekarang ${count}`,
);
