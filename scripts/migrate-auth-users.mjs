// One-off: create/link Supabase Auth users for every student and create the `guru` admin.
//
// Usage (Node 20; lib/auth.js is ESM in a typeless package, supabase-js needs native WebSocket):
//   node --experimental-websocket --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --env-file=<env file> scripts/migrate-auth-users.mjs [--dry-run] [--sync] --confirm-ref=<project ref>
//   Staging: scripts/staging.sh run node --experimental-websocket \
//     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/migrate-auth-users.mjs --dry-run
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// --confirm-ref must equal the ref in NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co);
// checked before any request. --dry-run performs no writes and needs no --confirm-ref.
// --sync resets the Auth password of already-linked students to their plaintext column value.
// Idempotent: safe to run repeatedly. Passwords of students are never printed.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { usernameToEmail, toAuthPassword } from "../lib/auth.js";

const CONCURRENCY = 5;
const PAGE = 1000;
const GURU_USERNAME = "guru";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
let dryRun = false;
let sync = false;
let confirmRef = null;
for (const arg of args) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--sync") sync = true;
  else if (arg.startsWith("--confirm-ref=")) confirmRef = arg.slice("--confirm-ref=".length);
  else fail(`Argumen tidak dikenal: ${arg}`);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) fail("NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.");

const refMatch = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim());
if (!refMatch) fail("NEXT_PUBLIC_SUPABASE_URL tidak berbentuk https://<ref>.supabase.co.");
const projectRef = refMatch[1];

if (!dryRun && confirmRef !== projectRef) {
  fail("Ditolak: tambahkan --confirm-ref=<ref project> yang sama dengan ref di NEXT_PUBLIC_SUPABASE_URL.");
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function readStudents() {
  for (const column of ["password", "password_legacy"]) {
    const rows = [];
    let missingColumn = false;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("students")
        .select(`id, username, ${column}, is_active, auth_user_id`)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) {
        if (from === 0 && /column|does not exist/i.test(error.message)) {
          missingColumn = true;
          break;
        }
        fail(`Gagal membaca students: ${error.message}`);
      }
      for (const row of data) rows.push({ ...row, plain: row[column] });
      if (data.length < PAGE) break;
    }
    if (!missingColumn) return rows;
  }
  return fail("Kolom password / password_legacy tidak ditemukan di students.");
}

async function readAuthUsers() {
  const byEmail = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) fail(`Gagal membaca auth users: ${error.message}`);
    for (const user of data.users) if (user.email) byEmail.set(user.email.toLowerCase(), user);
    if (data.users.length < PAGE) break;
  }
  return byEmail;
}

async function runPool(items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

const students = await readStudents();
const authByEmail = await readAuthUsers();

const counts = { dibuat: 0, ditautkan: 0, disinkron: 0 };
const failures = [];
const toCreate = [];
const toLink = [];
const toSync = [];

for (const student of students) {
  let email;
  try {
    email = usernameToEmail(student.username);
  } catch (e) {
    failures.push({ username: student.username, message: e.message });
    continue;
  }
  if (typeof student.plain !== "string" || student.plain === "") {
    failures.push({ username: student.username, message: "Password kosong." });
    continue;
  }
  if (student.auth_user_id) {
    if (sync) toSync.push(student);
  } else if (authByEmail.has(email)) {
    toLink.push({ student, userId: authByEmail.get(email).id });
  } else {
    toCreate.push({ student, email });
  }
}

const guruEmail = usernameToEmail(GURU_USERNAME);
const guruExists = authByEmail.has(guruEmail);

if (dryRun) {
  console.log(`[dry-run] ref: ${projectRef}`);
  console.log(`siswa: ${students.length}`);
  console.log(`akan dibuat: ${toCreate.length}`);
  console.log(`akan ditautkan: ${toLink.length}`);
  console.log(`akan disinkron: ${toSync.length}`);
  console.log(`guru: ${guruExists ? "sudah ada" : "akan dibuat"}`);
  console.log(`gagal: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f.username}: ${f.message}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

async function linkStudent(studentId, userId) {
  const { error } = await supabase.from("students").update({ auth_user_id: userId }).eq("id", studentId);
  if (error) throw new Error(`Gagal mengisi auth_user_id: ${error.message}`);
}

await runPool(toCreate, async ({ student, email }) => {
  try {
    let userId;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: toAuthPassword(student.plain),
      email_confirm: true,
      app_metadata: { role: "student", student_id: student.id },
    });
    if (error) throw new Error(error.message);
    userId = data.user.id;
    await linkStudent(student.id, userId);
    counts.dibuat++;
  } catch (e) {
    failures.push({ username: student.username, message: e.message });
  }
});

await runPool(toLink, async ({ student, userId }) => {
  try {
    await linkStudent(student.id, userId);
    counts.ditautkan++;
  } catch (e) {
    failures.push({ username: student.username, message: e.message });
  }
});

await runPool(toSync, async (student) => {
  try {
    const { error } = await supabase.auth.admin.updateUserById(student.auth_user_id, {
      password: toAuthPassword(student.plain),
    });
    if (error) throw new Error(error.message);
    counts.disinkron++;
  } catch (e) {
    failures.push({ username: student.username, message: e.message });
  }
});

let guruStatus = "sudah ada (tidak diubah)";
if (!guruExists) {
  const guruPassword = randomBytes(18).toString("base64url");
  const { error } = await supabase.auth.admin.createUser({
    email: guruEmail,
    password: guruPassword,
    email_confirm: true,
    app_metadata: { role: "admin" },
  });
  if (error) {
    failures.push({ username: GURU_USERNAME, message: error.message });
    guruStatus = "gagal";
  } else {
    guruStatus = "dibuat";
    console.log("PASSWORD GURU (simpan sekarang, tidak ditampilkan lagi):");
    console.log(guruPassword);
  }
}

console.log(`dibuat: ${counts.dibuat}`);
console.log(`ditautkan: ${counts.ditautkan}`);
console.log(`disinkron: ${counts.disinkron}`);
console.log(`guru: ${guruStatus}`);
console.log(`gagal: ${failures.length}`);
for (const f of failures) console.log(`  - ${f.username}: ${f.message}`);
process.exit(failures.length > 0 ? 1 : 0);
