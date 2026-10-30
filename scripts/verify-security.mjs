#!/usr/bin/env node
// HTTP and realtime evidence of what the anon key (and optionally one student) can
// and cannot do against Supabase. Prints one line "PASS|FAIL <check> (<detail>)" per
// check and exits 1 when any check fails. Prints only status codes, error codes and
// row counts: never row contents, keys, tokens or passwords.
//
// Usage:
//   node scripts/verify-security.mjs --phase=before|after [--read-only]
//        [--student=<username>:<password>] [--trigger-with-service-role]
//
//   --phase=before  old public access still open (Tahap 1-3): every anon check must
//                   be ALLOWED. Includes a replay of the old app's anon calls (select
//                   students with the password column, insert + delete an attendance
//                   with the old payload, insert + delete a holiday, update + restore
//                   prayer_schedule, select sync_changes). Leaves data unchanged.
//   --phase=after   Tahap 4 applied: every anon check must be REJECTED (401/403/42501,
//                   or 0 rows for a select). Write probes use the marker date
//                   1900-01-01 or ids that cannot exist; a write that unexpectedly
//                   succeeds is deleted again and reported as FAIL. Realtime must
//                   deliver no row data; anon still gets an empty "Error 401:
//                   Unauthorized" notice per change (counted, not a failure).
//                   The after-phase realtime check is only meaningful with
//                   --trigger-with-service-role (something must change during the
//                   listen); without it the check prints SKIP, unless row data
//                   arrives anyway (FAIL).
//   Realtime, both phases: a channel that does not reach SUBSCRIBED is a FAIL.
//   Output: PASS / FAIL / SKIP lines; SKIP is neither pass nor fail. Summary
//   "ALL PASS[, N SKIP]" (exit 0) or "N FAIL[, M SKIP]" (exit 1).
//   --read-only     skip every write check (use on production before Tahap 4).
//   --student=u:p   also log in as that student. after: own profile is the only
//                   readable student row, credential columns are unreadable, direct
//                   attendance insert and the ranking RPC are rejected, realtime
//                   delivers no row data. before: login + own profile only.
//   --trigger-with-service-role
//                   during the 10 s realtime listen, insert and delete the holiday
//                   1900-01-01 with SUPABASE_SERVICE_ROLE_KEY so sync_changes gets
//                   rows, and listen with the service role as a control that must
//                   receive row data. STAGING ONLY. Not allowed with --read-only.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or
// NEXT_PUBLIC_SUPABASE_ANON_KEY); SUPABASE_SERVICE_ROLE_KEY only for
// --trigger-with-service-role (also used, when present, to clean up a write that
// should have been rejected).
//
// supabase-js needs a global WebSocket: Node 22+ has one, Node 20 needs
// --experimental-websocket. lib/auth.js is an ES module in a package without
// "type": "module"; --disable-warning hides the resulting warning.
//
// Staging (from the repo root):
//   scripts/staging.sh run node --experimental-websocket \
//     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-security.mjs \
//     --phase=after --student=9A_Irfan:123 --trigger-with-service-role
//
// Production (owner, from the repo root, with the production env file):
//   node --experimental-websocket --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --env-file=.env.local scripts/verify-security.mjs --phase=before --read-only
//   after Tahap 4:
//   node --experimental-websocket --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --env-file=.env.local scripts/verify-security.mjs --phase=after
//   (add --student=<username>:<password> for a real student account if wanted;
//   never --trigger-with-service-role on production.)

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { signInWithUsername } from "../lib/auth.js";

const MARKER_DATE = "1900-01-01";
const MISSING_ID = "__tidak_ada__";
const REALTIME_LISTEN_MS = 10_000;
const STUDENT_COLUMNS = "id,nis,name,class_name,gender,username,is_active";
const OLD_STUDENT_COLUMNS = "id,nis,name,class_name,gender,username,password";
const OLD_ATTENDANCE_COLUMNS = "id,student_id,student_name,class_name,date,time,status";
const OLD_SYNC_COLUMNS = "id,table_name,operation,record_id,record_date,student_id,row_data";

const USAGE =
  "Usage: node scripts/verify-security.mjs --phase=before|after [--read-only] " +
  "[--student=<username>:<password>] [--trigger-with-service-role]";

function parseArgs(argv) {
  const options = { phase: null, readOnly: false, student: null, trigger: false };
  for (const arg of argv) {
    if (arg.startsWith("--phase=")) options.phase = arg.slice("--phase=".length);
    else if (arg === "--read-only") options.readOnly = true;
    else if (arg === "--trigger-with-service-role") options.trigger = true;
    else if (arg.startsWith("--student=")) {
      const value = arg.slice("--student=".length);
      const colon = value.indexOf(":");
      if (colon <= 0) throw new Error("--student harus berbentuk <username>:<password>.");
      options.student = { username: value.slice(0, colon), password: value.slice(colon + 1) };
    } else throw new Error(`Argumen tidak dikenal: ${arg.split("=")[0]}`);
  }
  if (options.phase !== "before" && options.phase !== "after") {
    throw new Error("--phase=before atau --phase=after wajib diisi.");
  }
  if (options.readOnly && options.trigger) {
    throw new Error("--trigger-with-service-role menulis data; tidak boleh bersama --read-only.");
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(USAGE);
  process.exit(2);
}

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY wajib diisi.");
  process.exit(2);
}
if (options.trigger && !serviceKey) {
  console.error("--trigger-with-service-role membutuhkan SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
if (typeof globalThis.WebSocket === "undefined") {
  console.error("WebSocket global tidak tersedia. Jalankan dengan Node 22+ atau --experimental-websocket.");
  process.exit(2);
}

const BEFORE = options.phase === "before";
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const service = serviceKey ? createClient(url, serviceKey, clientOptions) : null;

let failures = 0;
let skips = 0;
function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
// SKIP: the check could not prove anything; counts as neither pass nor fail.
function skip(name, reason) {
  skips += 1;
  console.log(`SKIP ${name} (${reason})`);
}
function note(text) {
  console.log(`# ${text}`);
}

// --- REST helpers -----------------------------------------------------------

async function rest(method, path, { token, body, prefer } = {}) {
  const headers = { apikey: anonKey };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  let response;
  try {
    response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, code: "NETWORK", rows: null };
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const ok = response.status >= 200 && response.status < 300;
  return {
    status: response.status,
    code: ok ? null : (json && json.code) || null,
    rows: ok && Array.isArray(json) ? json : null,
    json: ok ? json : null,
    // Used only to recognise known denial messages; never printed.
    message: ok ? null : (json && json.message) || null,
  };
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
const E_ADMIN_ONLY = "Hanya guru yang dapat melakukan aksi ini.";
const isRejected = (r) => r.status === 401 || r.status === 403 || r.code === "42501";
const describe = (r) =>
  [r.status, r.code, r.rows ? `${r.rows.length} rows` : null].filter(Boolean).join(", ");

async function cleanupMarker(table, filter, token) {
  const viaSame = await rest("DELETE", `${table}?${filter}`, { token, prefer: "return=minimal" });
  if (ok2xx(viaSame)) return "deleted";
  if (service) {
    const column = filter.slice(0, filter.indexOf("="));
    const value = filter.slice(filter.indexOf("=eq.") + 4);
    const { error } = await service.from(table).delete().eq(column, value);
    if (!error) return "deleted with service role";
  }
  return `HAPUS MANUAL: ${table}?${filter}`;
}

// --- anon REST ----------------------------------------------------------------

const SELECT_CHECKS = BEFORE
  ? [
      ["students", `students?select=${OLD_STUDENT_COLUMNS}&order=created_at.asc`],
      ["attendances", `attendances?select=${OLD_ATTENDANCE_COLUMNS}&order=created_at.desc`],
      ["holidays", "holidays?select=date&order=created_at.asc"],
      ["prayer_schedule", "prayer_schedule?select=enabled,start_time,end_time&id=eq.1"],
      ["sync_changes", `sync_changes?select=${OLD_SYNC_COLUMNS}&order=id.desc&limit=1000`],
    ]
  : [
      ["students", "students?select=id"],
      ["attendances", "attendances?select=id"],
      ["holidays", "holidays?select=date"],
      ["prayer_schedule", "prayer_schedule?select=id"],
      ["sync_changes", "sync_changes?select=id"],
    ];

async function anonSelects() {
  for (const [table, path] of SELECT_CHECKS) {
    const r = await rest("GET", path);
    if (BEFORE) {
      let pass = ok2xx(r) && r.rows !== null;
      let extra = "";
      if (pass && table === "students") {
        pass = r.rows.length > 0 && r.rows.every((row) => Object.hasOwn(row, "password"));
        extra = ", password column readable";
      }
      if (pass && table === "prayer_schedule") pass = r.rows.length === 1;
      report(`anon select ${table} allowed`, pass, describe(r) + (pass ? extra : ""));
    } else {
      const pass = isRejected(r) || (ok2xx(r) && r.rows !== null && r.rows.length === 0);
      report(`anon select ${table} rejected`, pass, describe(r));
    }
  }
}

function firstOfMonth() {
  const jakarta = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  return `${jakarta}-01`;
}

async function anonRanking() {
  const r = await rest("POST", "rpc/get_monthly_class_prayer_ranking", {
    body: { p_month: firstOfMonth(), p_class_name: null },
  });
  if (BEFORE) report("anon rpc get_monthly_class_prayer_ranking allowed", ok2xx(r), describe(r));
  else report("anon rpc get_monthly_class_prayer_ranking rejected", isRejected(r), describe(r));
}

async function anonHolidayWrite() {
  const filter = `date=eq.${MARKER_DATE}`;
  if (BEFORE) {
    const existing = await rest("GET", `holidays?select=date&${filter}`);
    if (!ok2xx(existing) || existing.rows.length !== 0) {
      report(`anon insert holidays ${MARKER_DATE} allowed`, false, `marker precheck ${describe(existing)}`);
      return;
    }
  }
  const r = await rest("POST", "holidays", { body: { date: MARKER_DATE }, prefer: "return=minimal" });
  if (BEFORE) {
    report(`anon insert holidays ${MARKER_DATE} allowed`, ok2xx(r), describe(r));
    if (!ok2xx(r)) return;
    // Old app "hapus hari libur": delete().eq("date", ...)
    const del = await rest("DELETE", `holidays?${filter}`, { prefer: "return=representation" });
    const after = await rest("GET", `holidays?select=date&${filter}`);
    report(
      `anon delete holidays ${MARKER_DATE} allowed`,
      ok2xx(del) && del.rows?.length === 1 && after.rows?.length === 0,
      `${describe(del)}; remaining ${after.rows ? after.rows.length : after.status}`,
    );
  } else if (ok2xx(r)) {
    const cleanup = await cleanupMarker("holidays", filter);
    report(`anon insert holidays ${MARKER_DATE} rejected`, false, `${describe(r)} — insert SUCCEEDED, ${cleanup}`);
  } else {
    report(`anon insert holidays ${MARKER_DATE} rejected`, isRejected(r), describe(r));
  }
}

async function anonAttendanceWrite() {
  const id = `verify-security-${randomUUID()}`;
  const filter = `id=eq.${id}`;
  if (BEFORE) {
    // Old app recordAttendance(): insert with the old payload shape, status Hadir.
    const students = await rest("GET", "students?select=id,name,class_name&limit=1");
    if (!ok2xx(students) || students.rows.length !== 1) {
      report("anon insert attendances (old payload, Hadir) allowed", false, `no student ${describe(students)}`);
      return;
    }
    const [student] = students.rows;
    const r = await rest("POST", "attendances", {
      body: {
        id,
        student_id: String(student.id),
        student_name: student.name,
        class_name: student.class_name,
        date: MARKER_DATE,
        time: "12.00",
        status: "Hadir",
      },
      prefer: "return=minimal",
    });
    report("anon insert attendances (old payload, Hadir) allowed", ok2xx(r), describe(r));
    if (!ok2xx(r)) return;
    // Old app confirmCancelAttendance(): delete().eq("id", ...)
    const del = await rest("DELETE", `attendances?${filter}`, { prefer: "return=representation" });
    const after = await rest("GET", `attendances?select=id&${filter}`);
    report(
      "anon delete attendances (old app cancel) allowed",
      ok2xx(del) && del.rows?.length === 1 && after.rows?.length === 0,
      `${describe(del)}; remaining ${after.rows ? after.rows.length : after.status}`,
    );
    return;
  }
  const r = await rest("POST", "attendances", {
    body: {
      id,
      student_id: MISSING_ID,
      student_name: "verify-security",
      class_name: "verify-security",
      date: MARKER_DATE,
      time: "12.00",
      status: "Hadir",
    },
    prefer: "return=minimal",
  });
  if (ok2xx(r)) {
    const cleanup = await cleanupMarker("attendances", filter);
    report("anon insert attendances rejected", false, `${describe(r)} — insert SUCCEEDED, ${cleanup}`);
  } else {
    report("anon insert attendances rejected", isRejected(r), describe(r));
  }
}

function shiftTime(hhmmss, minutes) {
  const [h, m] = hhmmss.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
}

async function anonScheduleUpdate() {
  if (BEFORE) {
    // Old app savePrayerSchedule(): update({enabled,start_time,end_time}).eq("id",1).select("id")
    const read = await rest("GET", "prayer_schedule?select=enabled,start_time,end_time&id=eq.1");
    if (!ok2xx(read) || read.rows.length !== 1) {
      report("anon update prayer_schedule allowed", false, `read ${describe(read)}`);
      return;
    }
    const original = read.rows[0];
    const changed = { ...original, end_time: shiftTime(original.end_time, -1) };
    const r = await rest("PATCH", "prayer_schedule?id=eq.1&select=id", {
      body: changed,
      prefer: "return=representation",
    });
    report("anon update prayer_schedule allowed", ok2xx(r) && r.rows?.length === 1, describe(r));
    const restore = await rest("PATCH", "prayer_schedule?id=eq.1&select=id", {
      body: original,
      prefer: "return=representation",
    });
    const check = await rest("GET", "prayer_schedule?select=enabled,start_time,end_time&id=eq.1");
    const restored =
      ok2xx(restore) &&
      check.rows?.length === 1 &&
      ["enabled", "start_time", "end_time"].every((k) => check.rows[0][k] === original[k]);
    report("anon restore prayer_schedule", restored, describe(restore));
    return;
  }
  // Identity update: changes nothing even if it were allowed.
  const r = await rest("PATCH", "prayer_schedule?id=eq.1&select=id", {
    body: { id: 1 },
    prefer: "return=representation",
  });
  report("anon update prayer_schedule rejected", isRejected(r), describe(r));
}

async function anonAttendanceDelete() {
  const r = await rest("DELETE", `attendances?id=eq.${MISSING_ID}`, { prefer: "return=minimal" });
  if (BEFORE) report(`anon delete attendances id=${MISSING_ID} allowed`, ok2xx(r), describe(r));
  else report(`anon delete attendances id=${MISSING_ID} rejected`, isRejected(r), describe(r));
}

// --- student ----------------------------------------------------------------

async function studentChecks(student) {
  const client = createClient(url, anonKey, clientOptions);
  const { error } = await signInWithUsername(client, student.username, student.password);
  report("student login", !error, error ? "login failed" : "signed in");
  if (error) return null;
  const { data } = await client.auth.getSession();
  const session = data.session;
  const token = session.access_token;

  const own = await rest("GET", `students?select=${STUDENT_COLUMNS}&auth_user_id=eq.${session.user.id}`, { token });
  report("student select own profile (auth_user_id)", ok2xx(own) && own.rows?.length === 1, describe(own));
  if (BEFORE) {
    note("student restriction checks run only with --phase=after");
    return { client, token };
  }

  const all = await rest("GET", `students?select=${STUDENT_COLUMNS}`, { token });
  report(
    "student select students returns only own row",
    ok2xx(all) && all.rows?.length === 1 && !Object.hasOwn(all.rows[0], "password"),
    describe(all),
  );

  const credentialProbes = [
    ["password", await rest("GET", "students?select=password", { token })],
    ["password_legacy", await rest("GET", "students?select=password_legacy", { token })],
    ["*", await rest("GET", "students?select=*", { token })],
  ];
  const credentialOk = credentialProbes.every(([, r]) =>
    ok2xx(r)
      ? r.rows.every((row) => !Object.hasOwn(row, "password") && !Object.hasOwn(row, "password_legacy"))
      : isRejected(r) || r.code === "42703",
  );
  report(
    "student cannot read credential columns",
    credentialOk,
    credentialProbes.map(([column, r]) => `${column}: ${describe(r)}`).join("; "),
  );

  if (options.readOnly) {
    note("student direct insert skipped (--read-only)");
  } else {
    const id = `verify-security-${randomUUID()}`;
    const ownRow = own.rows?.[0];
    const r = await rest("POST", "attendances", {
      token,
      body: {
        id,
        student_id: ownRow ? String(ownRow.id) : MISSING_ID,
        student_name: "verify-security",
        class_name: ownRow ? ownRow.class_name : "verify-security",
        date: MARKER_DATE,
        time: "12.00",
        status: "Hadir",
      },
      prefer: "return=minimal",
    });
    if (ok2xx(r)) {
      const cleanup = await cleanupMarker("attendances", `id=eq.${id}`, token);
      report("student direct insert attendances rejected", false, `${describe(r)} — insert SUCCEEDED, ${cleanup}`);
    } else {
      report("student direct insert attendances rejected", isRejected(r), describe(r));
    }
  }

  const ranking = await rest("POST", "rpc/get_monthly_class_prayer_ranking", {
    token,
    body: { p_month: firstOfMonth(), p_class_name: null },
  });
  report(
    "student rpc get_monthly_class_prayer_ranking rejected",
    isRejected(ranking) || (ranking.code === "P0001" && ranking.message === E_ADMIN_ONLY),
    describe(ranking),
  );
  return { client, token };
}

// --- realtime ---------------------------------------------------------------

// Realtime sends a role without SELECT on the table an empty notice per change
// (errors: ["Error 401: Unauthorized"], new/old without keys): table name, event type
// and commit time only. Those are counted separately from events carrying row data.
function listen(client, label) {
  const state = { label, status: "PENDING", dataEvents: 0, deniedNotices: 0 };
  state.ready = new Promise((resolve) => {
    state.channel = client
      .channel(`verify-security-${label}-${randomUUID()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "sync_changes" }, (payload) => {
        const hasData =
          Object.keys(payload.new || {}).length > 0 || Object.keys(payload.old || {}).length > 0;
        if (hasData) state.dataEvents += 1;
        else state.deniedNotices += 1;
      })
      .subscribe((status) => {
        state.status = status;
        if (status !== "CLOSED") resolve();
      });
    setTimeout(resolve, REALTIME_LISTEN_MS);
  });
  return state;
}

async function triggerSyncChanges() {
  const startedAt = new Date().toISOString();
  if (options.trigger) {
    const { error: insertError } = await service.from("holidays").insert({ date: MARKER_DATE });
    const { error: deleteError } = await service.from("holidays").delete().eq("date", MARKER_DATE);
    const { count } = await service
      .from("sync_changes")
      .select("id", { count: "exact", head: true })
      .eq("table_name", "holidays")
      .eq("record_id", MARKER_DATE)
      .gte("changed_at", startedAt);
    report(
      "service-role trigger wrote sync_changes rows",
      !insertError && !deleteError && (count ?? 0) >= 2,
      `${count ?? 0} rows`,
    );
    return "service role";
  }
  if (BEFORE && !options.readOnly) {
    const insert = await rest("POST", "holidays", { body: { date: MARKER_DATE }, prefer: "return=minimal" });
    const del = await rest("DELETE", `holidays?date=eq.${MARKER_DATE}`, { prefer: "return=minimal" });
    if (!ok2xx(insert) || !ok2xx(del)) {
      report("anon realtime trigger (holiday insert + delete)", false, `${insert.status}/${del.status}`);
    }
    return "anon holiday insert + delete";
  }
  return null;
}

async function realtimeChecks(studentSession) {
  const anonClient = createClient(url, anonKey, clientOptions);
  const listeners = [listen(anonClient, "anon")];
  if (studentSession && !BEFORE) {
    await studentSession.client.realtime.setAuth(studentSession.token);
    listeners.push(listen(studentSession.client, "student"));
  }
  // Control: service role bypasses RLS, so with the trigger it must see row data.
  // Without it, "0 events" could also mean the subscription is not delivering
  // anything at all (Realtime reports SUBSCRIBED even for a table that does not exist).
  const control = options.trigger ? listen(service, "control") : null;
  await Promise.all([...listeners, ...(control ? [control] : [])].map((l) => l.ready));
  const subscribedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const trigger = await triggerSyncChanges();
  const remaining = REALTIME_LISTEN_MS - (Date.now() - subscribedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));

  if (control) {
    report(
      "control (service role) realtime sync_changes 10s receives row data",
      control.status === "SUBSCRIBED" && control.dataEvents > 0,
      `${control.status}, ${control.dataEvents} events with row data`,
    );
  }
  for (const l of listeners) {
    const name = `${l.label} realtime sync_changes 10s`;
    const detail =
      `${l.status}, ${l.dataEvents} events with row data, ` +
      `${l.deniedNotices} empty "401 Unauthorized" notices, trigger: ${trigger || "none (passive)"}`;
    if (l.status !== "SUBSCRIBED") {
      // A channel that never subscribed (timeout, CHANNEL_ERROR, socket failure)
      // proves nothing about access, in either phase.
      report(`${name} subscribed`, false, detail);
    } else if (BEFORE && trigger) {
      report(`${name} receives row data`, l.dataEvents > 0, detail);
    } else if (BEFORE) {
      report(`${name} subscribes (passive, no trigger)`, true, detail);
    } else if (!trigger) {
      if (l.dataEvents > 0) report(`${name} receives no row data`, false, detail);
      else skip(`${name} receives no row data`, "tanpa pemicu — jalankan dengan --trigger-with-service-role di staging");
    } else {
      report(`${name} receives no row data`, l.dataEvents === 0, detail);
    }
  }
  await anonClient.removeAllChannels();
  if (studentSession) await studentSession.client.removeAllChannels();
  if (control) await service.removeAllChannels();
}

// --- main ---------------------------------------------------------------------

note(`phase=${options.phase}${options.readOnly ? " read-only" : ""}${options.student ? " student" : ""}${options.trigger ? " trigger=service-role" : ""}`);
await anonSelects();
await anonRanking();
if (options.readOnly) {
  note("write checks skipped (--read-only)");
} else {
  await anonHolidayWrite();
  await anonAttendanceWrite();
  await anonScheduleUpdate();
  await anonAttendanceDelete();
}
const studentSession = options.student ? await studentChecks(options.student) : null;
await realtimeChecks(studentSession);
if (studentSession) await studentSession.client.auth.signOut({ scope: "local" });

const skipped = skips ? `, ${skips} SKIP` : "";
console.log(failures ? `${failures} FAIL${skipped}` : `ALL PASS${skipped}`);
process.exit(failures ? 1 : 0);
