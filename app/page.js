"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { supabase } from "../lib/supabase";
import {
  ADMIN_ACTIVITY_KEY,
  E_LOGIN_RETRY,
  LEGACY_STORAGE_KEYS,
  isAdminSessionExpired,
  migrateLegacySession,
  signInWithUsername,
} from "../lib/auth";
import {
  adminDeleteAttendance,
  adminMarkAttendance,
  adminSetHoliday,
  adminSetPrayerSchedule,
  changeOwnPassword,
  createStudent,
  deactivateStudent,
  fetchOwnStudentProfile,
  importStudents,
  resetStudentPassword,
  submitAttendance,
  submitLateAttendance,
  updateStudent,
} from "../lib/api";
import { normalizeStudentName } from "../lib/admin-students";
import { selectReportStudents } from "../lib/report-students";
import {
  ArrowLeft,
  BookOpen,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  CheckCircle,
  ClipboardText,
  DownloadSimple,
  Eye,
  EyeSlash,
  Gear,
  House,
  List,
  MagnifyingGlass,
  PencilSimple,
  X,
  Plus,
  QrCode,
  SignOut,
  Trash,
  UserCircle,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";

// Loaded on demand so students opening /dzuhur do not download admin-only libraries.
const QRCodeCanvas = dynamic(
  () => import("qrcode.react").then((mod) => mod.QRCodeCanvas),
  { ssr: false },
);

// Admin-only cache of students and holidays (never passwords).
const REMOTE_CACHE_KEY = "dzuhur-cache-v3";
const LEGACY_REMOTE_CACHE_KEY = "dzuhur-supabase-cache-v2";
const REMOTE_CACHE_TTL_MS = 29 * 24 * 60 * 60 * 1000;
// Students have no realtime; on tab focus they refetch, at most this often.
const FOCUS_REFRESH_MIN_MS = 5 * 1000;
const ATTENDANCE_COLUMNS =
  "id,student_id,student_name,class_name,date,time,status";
const STUDENT_COLUMNS = "id,nis,name,class_name,gender,username,is_active";
const ADMIN_USER = { role: "admin", name: "Guru Admin", username: "guru" };
const E_NO_STUDENT = "Akun siswa tidak ditemukan atau nonaktif.";
const E_SESSION_ENDED = "Sesi berakhir. Silakan masuk kembali.";
const E_ADMIN_IDLE =
  "Sesi guru berakhir karena tidak aktif lebih dari 7 hari. Silakan masuk kembali.";
const ADMIN_ACTIVITY_WRITE_MS = 60 * 1000;
// Initial password for students added by hand or imported; sent only to the admin API.
const DEFAULT_STUDENT_PASSWORD = "123";
// Matches the admin import route's per-request limit.
const IMPORT_BATCH_SIZE = 100;
const PAGE_SIZE = 50;

function normalizeImportHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s./_-]/g, "");
}

async function fetchAllSupabaseRows(table, columns) {
  const pageSize = 1000;
  const rows = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("created_at", { ascending: table === "students" })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
    page += 1;
  }
}

async function fetchAttendanceRows({ startDate, endDate, studentId, className } = {}) {
  const pageSize = 1000;
  const rows = [];
  let page = 0;
  while (true) {
    let query = supabase
      .from("attendances")
      .select(ATTENDANCE_COLUMNS)
      .order("created_at", { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (startDate) query = query.gte("date", startDate);
    if (endDate) query = query.lte("date", endDate);
    if (studentId) query = query.eq("student_id", String(studentId));
    if (className && className !== "Semua kelas") query = query.eq("class_name", className);
    const { data, error } = await query;
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) {
      return { data: rows.map(mapAttendance), error: null };
    }
    page += 1;
  }
}

async function fetchLatestSyncCursor() {
  const { data, error } = await supabase
    .from("sync_changes")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return error ? 0 : Number(data?.id || 0);
}

async function fetchSyncChanges(source) {
  const pageSize = 1000;
  const changes = [];
  let page = 0;
  while (true) {
    let query = supabase
      .from("sync_changes")
      .select("id,table_name,operation,record_id,record_date,student_id,row_data")
      .gt("id", source.cursor || 0)
      .order("id", { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (source.tableName) query = query.eq("table_name", source.tableName);
    if (source.recordId) query = query.eq("record_id", String(source.recordId));
    if (source.recordDate) query = query.eq("record_date", source.recordDate);
    if (source.startDate) query = query.gte("record_date", source.startDate);
    if (source.endDate) query = query.lte("record_date", source.endDate);
    if (source.studentId) query = query.eq("student_id", String(source.studentId));
    const { data, error } = await query;
    if (error) return { data: null, error };
    changes.push(...(data || []));
    if (!data || data.length < pageSize) return { data: changes, error: null };
    page += 1;
  }
}

function mapStudent(item) {
  return {
    id: item.id,
    nis: item.nis || "",
    name: normalizeStudentName(item.name),
    className: item.class_name,
    gender: item.gender || "",
    username: item.username,
    isActive: item.is_active !== false,
  };
}

function mapAttendance(item) {
  return {
    id: item.id,
    studentId: item.student_id,
    studentName: item.student_name,
    className: item.class_name,
    date: item.date,
    time: item.time,
    status: item.status,
  };
}

function mapClassRanking(item) {
  return {
    className: item.class_name,
    studentCount: Number(item.student_count || 0),
    sholatCount: Number(item.sholat_count || 0),
    haidCount: Number(item.haid_count || 0),
    absentCount: Number(item.absent_count || 0),
    expectedAttendance: Number(item.expected_attendance || 0),
    percentage: Number(item.percentage || 0),
  };
}

async function fetchMonthlyClassPrayerRanking({ monthStart, className }) {
  const { data, error } = await supabase.rpc("get_monthly_class_prayer_ranking", {
    p_month: monthStart,
    p_class_name: className === "Semua kelas" ? null : className,
  });
  return { data: (data || []).map(mapClassRanking), error };
}

function buildMonthlyClassPrayerRanking(students, attendanceRows, startDate, endDate, className) {
  const days = Math.round(
    (new Date(`${endDate}T12:00:00`) - new Date(`${startDate}T12:00:00`)) / 86400000,
  ) + 1;
  const classNames = [...new Set(
    students
      .filter((student) => className === "Semua kelas" || student.className === className)
      .map((student) => student.className)
      .filter(Boolean),
  )].sort();
  return classNames
    .map((currentClass) => {
      const studentCount = students.filter((student) => student.className === currentClass).length;
      const records = attendanceRows.filter(
        (item) => item.className === currentClass && item.date >= startDate && item.date <= endDate,
      );
      const sholatCount = records.filter((item) => item.status !== "Haid").length;
      const haidCount = records.filter((item) => item.status === "Haid").length;
      const expectedAttendance = studentCount * days;
      const absentCount = Math.max(expectedAttendance - records.length, 0);
      return {
        className: currentClass,
        studentCount,
        sholatCount,
        haidCount,
        absentCount,
        expectedAttendance,
        percentage: expectedAttendance ? Number(((sholatCount / expectedAttendance) * 100).toFixed(1)) : 0,
      };
    })
    .sort(
      (first, second) =>
        second.percentage - first.percentage ||
        second.sholatCount - first.sholatCount ||
        first.className.localeCompare(second.className, "id", { numeric: true }),
    );
}

function upsertById(items, item, prepend = true) {
  const index = items.findIndex((current) => current.id === item.id);
  if (index < 0) return prepend ? [item, ...items] : [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function readRemoteCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(REMOTE_CACHE_KEY) || "null");
    if (
      !cache ||
      !Number.isFinite(cache.snapshotAt) ||
      !Number.isFinite(cache.cursors?.students) ||
      !Number.isFinite(cache.cursors?.holidays) ||
      !Array.isArray(cache.students) ||
      !Array.isArray(cache.holidays)
    ) {
      return null;
    }
    return cache;
  } catch {
    localStorage.removeItem(REMOTE_CACHE_KEY);
    return null;
  }
}

async function fetchServerTime() {
  const { data, error } = await supabase.rpc("get_server_time");
  return error || !data ? null : new Date(data);
}

// Only the fields mapStudent produces, so a typed password never reaches the cache.
function toCachedStudent(student) {
  return {
    id: student.id,
    nis: student.nis,
    name: student.name,
    className: student.className,
    gender: student.gender,
    username: student.username,
    isActive: student.isActive,
  };
}

function mapPrayerSchedule(row) {
  return {
    enabled: row.enabled,
    start: row.start_time.slice(0, 5),
    end: row.end_time.slice(0, 5),
    attendanceStartDate: row.attendance_start_date,
  };
}

async function fetchPrayerSchedule() {
  const { data, error } = await supabase
    .from("prayer_schedule")
    .select("enabled,start_time,end_time,attendance_start_date")
    .eq("id", 1)
    .single();
  return { schedule: data && mapPrayerSchedule(data), error };
}

function parseImportedRows(rows, existingStudents = []) {
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) =>
      ["nama", "n a m a", "l/p", "nis"].includes(
        String(cell || "")
          .toLowerCase()
          .trim(),
      ),
    ),
  );
  if (headerIndex < 0)
    throw new Error(
      "Header tidak ditemukan. Gunakan kolom NIS, Nama, L/P, dan Kelas.",
    );
  const headers = rows[headerIndex].map(normalizeImportHeader);
  const findColumn = (...names) =>
    headers.findIndex((header) => names.includes(header));
  const nameIndex = findColumn(
    "nama",
    "nama lengkap",
    "namasiswa",
    "namamurid",
  );
  const nisIndex = findColumn("nis", "nissiswa", "nomorinduk");
  const genderIndex = findColumn("l/p", "lp", "jeniskelamin", "gender");
  const religionIndex = findColumn("agm", "agama", "religion");
  const classIndex = findColumn("kelas", "class", "rombel");
  const classText = rows
    .slice(0, headerIndex)
    .flat()
    .map((cell) => String(cell || ""))
    .join(" ");
  const classMatch = classText.match(/kelas\s*:?\s*([A-Za-z0-9-]+)/i);
  const fallbackClass = classMatch?.[1] || "";
  if (nameIndex < 0) throw new Error("Kolom Nama tidak ditemukan.");
  if (religionIndex < 0) throw new Error("Kolom AGM/agama tidak ditemukan.");
  const seenNis = new Set(
    existingStudents
      .map((student) => String(student.nis || "").trim())
      .filter(Boolean),
  );
  const duplicates = [];
  const excludedNonIslam = [];
  let currentClass = fallbackClass;
  const students = rows
    .slice(headerIndex + 1)
    .map((row) => {
      const rowText = row.map((cell) => String(cell || "")).join(" ");
      const sectionMatch = rowText.match(/kelas\s*:?[\s]*([A-Za-z0-9-]+)/i);
      if (sectionMatch) {
        currentClass = sectionMatch[1].trim();
        return null;
      }
      if (
        row.some((cell) =>
          ["nama", "n a m a", "l/p", "nis", "agm"].includes(
            String(cell || "").toLowerCase().trim(),
          ),
        )
      )
        return null;
      const name = normalizeStudentName(row[nameIndex]);
      const nis = String(nisIndex >= 0 ? row[nisIndex] || "" : "").trim();
      const religion = String(row[religionIndex] || "")
        .trim()
        .toUpperCase();
      const genderValue = String(genderIndex >= 0 ? row[genderIndex] || "" : "")
        .trim()
        .toUpperCase();
      const className = String(
        classIndex >= 0 ? row[classIndex] || currentClass : currentClass,
      ).trim();
      if (!name || (!nis && !genderValue && !className)) return null;
      if (religion !== "IS") {
        excludedNonIslam.push({ name, nis, religion: religion || "kosong" });
        return null;
      }
      if (nis && seenNis.has(nis)) {
        duplicates.push({ name, nis });
        return null;
      }
      if (nis) seenNis.add(nis);
      const gender =
        genderValue === "P" || genderValue.includes("PEREMPUAN")
          ? "Perempuan"
          : genderValue === "L" || genderValue.includes("LAKI")
            ? "Laki-laki"
            : "";
      const username =
        nis ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ".")
          .replace(/^\.|\.$/g, "");
      return { nis, name, gender, className, username };
    })
    .filter(Boolean);
  return { students, excludedNonIslam, duplicates };
}

function formatDate() {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function jakartaMinutesNow() {
  const [hour, minute] = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Jakarta",
  })
    .format(new Date())
    .split(":")
    .map(Number);
  return hour * 60 + minute;
}

const defaultPrayerSchedule = {
  enabled: true,
  start: "11:30",
  end: "15:00",
  attendanceStartDate: "2026-08-01",
};

function timeToMinutes(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <BookOpen size={22} weight="bold" />
      </span>
      <span>
        Absensi<span>Sholat</span>
      </span>
    </div>
  );
}

// Returns one page of `items`; the page resets to 1 whenever `resetKey` changes
// (filter or search) and is clamped when the list shrinks.
function usePagination(items, resetKey) {
  const [state, setState] = useState({ page: 1, resetKey });
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(state.resetKey === resetKey ? state.page : 1, pageCount);
  const offset = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(offset, offset + PAGE_SIZE),
    offset,
    page,
    pageCount,
    total: items.length,
    setPage: (next) => setState({ page: next, resetKey }),
  };
}

function Pagination({ pagination }) {
  const ref = useRef(null);
  const { offset, page, pageCount, total, items, setPage } = pagination;
  if (pageCount <= 1) return null;
  function goTo(next) {
    setPage(next);
    ref.current?.previousElementSibling?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  return (
    <nav className="pagination" ref={ref} aria-label="Halaman">
      <span>
        {offset + 1}–{offset + items.length} dari {total}
      </span>
      <div>
        <button
          type="button"
          className="secondary"
          disabled={page === 1}
          onClick={() => goTo(page - 1)}
          aria-label="Halaman sebelumnya"
        >
          <CaretLeft size={16} />
        </button>
        <b>
          {page} / {pageCount}
        </b>
        <button
          type="button"
          className="secondary"
          disabled={page === pageCount}
          onClick={() => goTo(page + 1)}
          aria-label="Halaman berikutnya"
        >
          <CaretRight size={16} />
        </button>
      </div>
    </nav>
  );
}

function DatabaseLoading({ label }) {
  return (
    <div className="database-loading" role="status" aria-live="polite">
      <span className="database-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default function Home() {
  if (!supabase) return <MissingConfiguration />;
  return <AbsensiApp />;
}

function MissingConfiguration() {
  return (
    <main className="session-loading">
      <div>
        <Logo />
        <p className="form-error" role="alert">
          <WarningCircle size={18} />
          Aplikasi belum terhubung ke database. Hubungi admin sekolah untuk
          mengatur konfigurasi Supabase.
        </p>
      </div>
    </main>
  );
}

function clearAccountStorage() {
  localStorage.removeItem(REMOTE_CACHE_KEY);
  localStorage.removeItem(LEGACY_REMOTE_CACHE_KEY);
  localStorage.removeItem(ADMIN_ACTIVITY_KEY);
}

function readAdminLastActive() {
  return Number(localStorage.getItem(ADMIN_ACTIVITY_KEY)) || null;
}

function AbsensiApp() {
  const [students, setStudents] = useState([]);
  const [attendances, setAttendances] = useState([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [attendanceSyncScope, setAttendanceSyncScope] = useState(null);
  const [reportHistory, setReportHistory] = useState([]);
  const [reportClassRanking, setReportClassRanking] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportSyncScope, setReportSyncScope] = useState(null);
  const [attendanceCheckRecords, setAttendanceCheckRecords] = useState([]);
  const [attendanceCheckLoading, setAttendanceCheckLoading] = useState(false);
  const [attendanceCheckSyncScope, setAttendanceCheckSyncScope] = useState(null);
  const [serverNow, setServerNow] = useState(new Date());
  const [holidays, setHolidays] = useState([]);
  const [accountDataLoading, setAccountDataLoading] = useState(false);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [view, setView] = useState("dashboard");
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("Semua kelas");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [attendanceNotice, setAttendanceNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [attendanceDeleteTarget, setAttendanceDeleteTarget] = useState(null);
  const [menstruationDecision, setMenstruationDecision] = useState(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [prayerSchedule, setPrayerSchedule] = useState(defaultPrayerSchedule);
  const [scheduleReady, setScheduleReady] = useState(false);
  const remoteSnapshotAt = useRef(0);
  const cacheCursors = useRef({ students: 0, holidays: 0 });
  const reportRequest = useRef(0);
  const attendanceCheckRequest = useRef(0);
  // Auth user id whose profile is currently shown; null while signed out.
  const authUserId = useRef(null);
  // Bumped on every session change so a slower, older resolution is discarded.
  const authRun = useRef(0);
  const loginInFlight = useRef(false);
  // A student's own attendance submit in progress (blocks double clicks).
  const attendanceInFlight = useRef(false);
  // Bumped on each attendance write so an older focus refetch does not undo it.
  const attendanceWriteSeq = useRef(0);
  // Blocks a second submit of the student form while the first is in flight.
  const studentSaveInFlight = useRef(false);

  const todayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(serverNow);
  const [attendanceCheckDate, setAttendanceCheckDate] = useState(todayKey);

  function resetAccountState() {
    remoteSnapshotAt.current = 0;
    cacheCursors.current = { students: 0, holidays: 0 };
    setStudents([]);
    setAttendances([]);
    setAttendanceSyncScope(null);
    setReportHistory([]);
    setReportClassRanking([]);
    setReportSyncScope(null);
    setAttendanceCheckRecords([]);
    setAttendanceCheckSyncScope(null);
    setHolidays([]);
    setView("dashboard");
    setEditing(null);
    setDeleteTarget(null);
    setAttendanceDeleteTarget(null);
    setPasswordModalOpen(false);
    setAttendanceNotice("");
  }

  // Ends the local session. `callSignOut` is false when Supabase already
  // dropped the session (SIGNED_OUT event), so there is nothing to revoke.
  async function endSession(message, { callSignOut = true } = {}) {
    authRun.current += 1;
    authUserId.current = null;
    clearAccountStorage();
    resetAccountState();
    setUser(null);
    setNotice(message);
    if (callSignOut) await supabase.auth.signOut({ scope: "local" });
  }

  function showUser(session, nextUser) {
    // Another account signed in (e.g. from a second tab): drop the old data.
    if (authUserId.current && authUserId.current !== session.user.id) {
      resetAccountState();
    }
    authUserId.current = session.user.id;
    setNotice("");
    setUser(nextUser);
  }

  // Turns a Supabase session into the app's `user`. `source` is "login" for a
  // sign-in from this tab's form, otherwise the session is being restored.
  async function applySession(session, source) {
    const run = ++authRun.current;
    if (!session) {
      authUserId.current = null;
      setUser(null);
      return;
    }
    const role = session.user.app_metadata?.role;
    if (role === "admin") {
      const lastActive = readAdminLastActive();
      if (source !== "login" && isAdminSessionExpired(lastActive, Date.now())) {
        await endSession(E_ADMIN_IDLE);
        return;
      }
      if (source === "login" || lastActive === null) {
        localStorage.setItem(ADMIN_ACTIVITY_KEY, String(Date.now()));
      }
      showUser(session, ADMIN_USER);
      return;
    }
    if (role !== "student") {
      await endSession(E_NO_STUDENT);
      return;
    }
    const { data, error } = await fetchOwnStudentProfile(session.user.id);
    if (run !== authRun.current) return;
    if (error) {
      // Keep the Supabase session: a network error is not a reason to sign out.
      authUserId.current = null;
      setUser(null);
      setNotice(`Gagal memuat profil murid: ${error.message}`);
      return;
    }
    if (!data || data.is_active === false) {
      await endSession(E_NO_STUDENT);
      return;
    }
    showUser(session, { ...mapStudent(data), role: "student" });
  }

  useEffect(() => {
    let active = true;
    let subscription = null;
    async function restoreSession() {
      try {
        const initial = await supabase.auth.getSession();
        if (initial.data.session) {
          for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
        } else {
          const migration = await migrateLegacySession(
            localStorage,
            (username, password) =>
              signInWithUsername(supabase, username, password).then((result) => {
                if (!result.error) return true;
                return result.error === E_LOGIN_RETRY ? "retry" : false;
              }),
          );
          if (migration === "retry" && active) setNotice(E_LOGIN_RETRY);
        }
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        await applySession(data.session, "restore");
      } catch {
        if (active) setNotice(E_SESSION_ENDED);
      }
      if (!active) return;
      setReady(true);
      subscription = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "INITIAL_SESSION") return;
        // Supabase calls listeners while holding its auth lock; querying from
        // inside the callback would deadlock, so handle the event afterwards.
        setTimeout(() => {
          if (!active) return;
          if (event === "SIGNED_OUT") {
            if (authUserId.current) {
              endSession(E_SESSION_ENDED, { callSignOut: false });
            } else {
              authRun.current += 1;
            }
            return;
          }
          if (loginInFlight.current || !session) return;
          if (session.user.id !== authUserId.current) applySession(session, "restore");
        }, 0);
      }).data.subscription;
    }
    restoreSession();
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (user?.role !== "admin") return;
    function recordActivity() {
      const now = Date.now();
      const lastActive = readAdminLastActive();
      if (isAdminSessionExpired(lastActive, now)) {
        endSession(E_ADMIN_IDLE);
        return;
      }
      if (lastActive === null || now - lastActive >= ADMIN_ACTIVITY_WRITE_MS) {
        localStorage.setItem(ADMIN_ACTIVITY_KEY, String(now));
      }
    }
    window.addEventListener("pointerdown", recordActivity);
    window.addEventListener("keydown", recordActivity);
    return () => {
      window.removeEventListener("pointerdown", recordActivity);
      window.removeEventListener("keydown", recordActivity);
    };
  }, [user?.role]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const isAdmin = user.role === "admin";
    async function loadAccountData() {
      setAccountDataLoading(true);
      const cache = isAdmin ? readRemoteCache() : null;
      if (cache) {
        remoteSnapshotAt.current = cache.snapshotAt;
        cacheCursors.current = cache.cursors;
        setStudents(cache.students);
        setHolidays(cache.holidays);
      }
      const cacheIsFresh =
        cache && Date.now() - cache.snapshotAt < REMOTE_CACHE_TTL_MS;
      if (!cacheIsFresh) {
        // sync_changes is admin-only; students have no sync cursor.
        const cursor = isAdmin ? await fetchLatestSyncCursor() : 0;
        const [studentsResult, holidaysResult] = await Promise.all([
          isAdmin
            ? fetchAllSupabaseRows("students", STUDENT_COLUMNS)
            : { data: [], error: null },
          fetchAllSupabaseRows("holidays", "date"),
        ]);
        if (!active) return;
        const hasError = studentsResult.error || holidaysResult.error;
        if (hasError) {
          if (!cache) {
            setNotice(
              "Database belum siap. Jalankan schema Supabase terlebih dahulu.",
            );
          }
        } else {
          if (isAdmin) setStudents((studentsResult.data || []).map(mapStudent));
          setHolidays((holidaysResult.data || []).map((item) => item.date));
          remoteSnapshotAt.current = Date.now();
          cacheCursors.current = { students: cursor, holidays: cursor };
        }
      }
      if (active) setAccountDataLoading(false);
    }
    loadAccountData();
    return () => {
      active = false;
      setAccountDataLoading(false);
    };
  }, [user?.role, user?.id]);
  useEffect(() => {
    if (!user) return;
    const isAdmin = user.role === "admin";
    const studentId = isAdmin ? null : String(user.id);
    let active = true;
    let requestId = 0;
    let focusRefreshing = false;
    let lastFocusRefresh = Date.now();
    async function loadSchedule() {
      const id = ++requestId;
      const result = await fetchPrayerSchedule();
      if (!active || id !== requestId) return;
      if (result.error || !result.schedule) {
        setScheduleReady(false);
        setNotice(`Gagal memuat jadwal konfirmasi: ${result.error?.message || "Jadwal tidak ditemukan."}`);
      } else {
        setPrayerSchedule(result.schedule);
        setScheduleReady(true);
        setNotice((current) => current.startsWith("Gagal memuat jadwal konfirmasi:") ? "" : current);
      }
    }
    // Students have no realtime: refetch their own attendance and holidays.
    async function loadStudentData() {
      const writeSeq = attendanceWriteSeq.current;
      const [attendanceResult, holidaysResult] = await Promise.all([
        fetchAttendanceRows({ studentId }),
        fetchAllSupabaseRows("holidays", "date"),
      ]);
      if (!active) return;
      // Errors keep the data already shown; the next focus tries again.
      if (!attendanceResult.error && writeSeq === attendanceWriteSeq.current) {
        setAttendances(attendanceResult.data || []);
      }
      if (!holidaysResult.error) {
        setHolidays((holidaysResult.data || []).map((item) => item.date));
      }
    }
    async function onFocus() {
      if (focusRefreshing || Date.now() - lastFocusRefresh < FOCUS_REFRESH_MIN_MS) return;
      focusRefreshing = true;
      lastFocusRefresh = Date.now();
      try {
        await Promise.all(isAdmin ? [loadSchedule()] : [loadSchedule(), loadStudentData()]);
      } finally {
        focusRefreshing = false;
      }
    }
    const channel = isAdmin
      ? supabase
          .channel("prayer-schedule-sync")
          .on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "prayer_schedule",
            filter: "id=eq.1",
          }, loadSchedule)
          .subscribe((status) => {
            if (status === "SUBSCRIBED") loadSchedule();
          })
      : null;
    window.addEventListener("focus", onFocus);
    loadSchedule();
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.role, user?.id]);
  useEffect(() => {
    const ticker = setInterval(() => {
      setServerNow((current) => new Date(current.getTime() + 1000));
    }, 1000);
    let active = true;
    const sync = async () => {
      const current = await fetchServerTime();
      if (active && current) setServerNow(current);
    };
    sync();
    const syncTimer = setInterval(sync, 30000);
    return () => {
      active = false;
      clearInterval(ticker);
      clearInterval(syncTimer);
    };
  }, []);
  useEffect(() => {
    if (user?.role !== "admin") return;
    const timer = setTimeout(() => {
      // Logout may have cleared storage before this effect was cleaned up.
      if (!authUserId.current) return;
      try {
        localStorage.setItem(
          REMOTE_CACHE_KEY,
          JSON.stringify({
            snapshotAt: remoteSnapshotAt.current,
            cursors: cacheCursors.current,
            students: students.map(toCachedStudent),
            holidays,
          }),
        );
      } catch {
        localStorage.removeItem(REMOTE_CACHE_KEY);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [students, holidays, user?.role]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    async function loadAttendanceScope() {
      setAttendanceLoading(true);
      // sync_changes is admin-only; students have no sync cursor.
      const cursor = user.role === "admin" ? await fetchLatestSyncCursor() : 0;
      const result =
        user.role === "student"
          ? await fetchAttendanceRows({ studentId: user.id })
          : await fetchAttendanceRows({ startDate: todayKey, endDate: todayKey });
      if (!active) return;
      if (result.error) {
        setNotice(`Gagal memuat absensi: ${result.error.message}`);
      } else {
        setAttendances(result.data || []);
        setAttendanceSyncScope({
          cursor,
          key:
            user.role === "student"
              ? `student:${user.id}`
              : `date:${todayKey}`,
          studentId: user.role === "student" ? String(user.id) : null,
          startDate: user.role === "admin" ? todayKey : null,
          endDate: user.role === "admin" ? todayKey : null,
        });
      }
      setAttendanceLoading(false);
    }
    loadAttendanceScope();
    return () => {
      active = false;
    };
  }, [ready, user?.role, user?.id, todayKey]);
  useEffect(() => {
    // Realtime is admin-only: students cannot read sync_changes and refetch
    // their own data on focus instead (see the schedule effect above).
    if (user?.role !== "admin") return;
    const sources = [];
    const needsStudents =
      ["dashboard", "reports", "attendance-check", "students"].includes(view);
    if (needsStudents) {
      sources.push({
        cursor: cacheCursors.current.students,
        tableName: "students",
        realtimeFilter: "table_name=eq.students",
      });
    }
    if (
      view === "dashboard" &&
      attendanceSyncScope?.startDate === todayKey
    ) {
      sources.push({
        cursor: attendanceSyncScope.cursor,
        recordDate: todayKey,
        realtimeFilter: `record_date=eq.${todayKey}`,
      });
    } else if (view === "reports" && reportSyncScope) {
      sources.push({
        ...reportSyncScope,
        realtimeFilter: `record_date=gte.${reportSyncScope.startDate},record_date=lte.${reportSyncScope.endDate}`,
      });
    } else if (view === "attendance-check" && attendanceCheckSyncScope) {
      sources.push({
        ...attendanceCheckSyncScope,
        realtimeFilter: `record_date=eq.${attendanceCheckSyncScope.recordDate}`,
      });
    }
    if (["dashboard", "attendance-check"].includes(view)) {
      sources.push({
        cursor: cacheCursors.current.holidays,
        tableName: "holidays",
        realtimeFilter: "table_name=eq.holidays",
      });
    }
    if (!sources.length) return;

    let cancelled = false;
    let catchingUp = true;
    let queuedChanges = [];

    function applyChange(change) {
      const row = change.row_data;
      const deleting = change.operation === "DELETE";
      if (change.table_name === "students") {
        cacheCursors.current.students = Math.max(
          cacheCursors.current.students,
          Number(change.id),
        );
        if (deleting) {
          setStudents((current) =>
            current.filter((item) => String(item.id) !== String(change.record_id)),
          );
        } else {
          const student = mapStudent(row);
          setStudents((current) =>
            upsertById(current, student, change.operation === "INSERT"),
          );
        }
        return;
      }
      if (change.table_name === "holidays") {
        cacheCursors.current.holidays = Math.max(
          cacheCursors.current.holidays,
          Number(change.id),
        );
        const date = row.date;
        setHolidays((current) => {
          if (deleting) return current.filter((item) => item !== date);
          return current.includes(date) ? current : [...current, date];
        });
        return;
      }
      if (change.table_name !== "attendances") return;
      const record = mapAttendance(row);
      const updateSlice = (current) =>
        deleting
          ? current.filter((item) => String(item.id) !== String(change.record_id))
          : upsertById(current, record, change.operation === "INSERT");
      if (record.date === todayKey) setAttendances(updateSlice);
      if (
        reportSyncScope &&
        record.date >= reportSyncScope.startDate &&
        record.date <= reportSyncScope.endDate &&
        (reportSyncScope.className === "Semua kelas" || record.className === reportSyncScope.className)
      ) {
        setReportHistory(updateSlice);
      }
      if (attendanceCheckSyncScope?.recordDate === record.date) {
        setAttendanceCheckRecords(updateSlice);
      }
    }

    let channel = supabase.channel(`absensi-sync-${Date.now()}`);
    for (const source of sources) {
      channel = channel.on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sync_changes",
          filter: source.realtimeFilter,
        },
        (payload) => {
          if (catchingUp) queuedChanges.push(payload.new);
          else applyChange(payload.new);
        },
      );
    }
    channel.subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      const results = await Promise.all(sources.map(fetchSyncChanges));
      if (cancelled) return;
      const replayed = results.flatMap((result) => result.data || []);
      const changes = [...replayed, ...queuedChanges]
        .filter(
          (change, index, all) =>
            all.findIndex((candidate) => candidate.id === change.id) === index,
        )
        .sort((first, second) => Number(first.id) - Number(second.id));
      for (const change of changes) applyChange(change);
      queuedChanges = [];
      catchingUp = false;
      if (results.some((result) => result.error)) {
        setNotice("Sebagian perubahan terbaru gagal disinkronkan.");
      }
    });
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [
    ready,
    user?.role,
    user?.id,
    view,
    todayKey,
    attendanceSyncScope,
    reportSyncScope,
    attendanceCheckSyncScope,
  ]);
  useEffect(() => {
    if (!user || user.role !== "student") setMenstruationDecision(null);
  }, [user]);

  const todayAttendance = attendances.filter((item) => item.date === todayKey);
  // Deactivated students stay in state (cache, realtime) but are hidden everywhere.
  const activeStudents = useMemo(
    () => students.filter((student) => student.isActive !== false),
    [students],
  );
  const filteredStudents = useMemo(
    () =>
      activeStudents
        .filter(
          (student) =>
            (classFilter === "Semua kelas" ||
              student.className === classFilter) &&
            `${student.name} ${student.username}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((first, second) =>
          first.name.localeCompare(second.name, "id", { sensitivity: "base" }),
        ),
    [activeStudents, classFilter, query],
  );

  async function loadReportRange(startDate, endDate, className = "Semua kelas") {
    const requestId = ++reportRequest.current;
    setReportLoading(true);
    const cursor = await fetchLatestSyncCursor();
    const [result, rankingResult] = await Promise.all([
      fetchAttendanceRows({ startDate, endDate, className }),
      fetchMonthlyClassPrayerRanking({ monthStart: startDate, className }),
    ]);
    if (requestId !== reportRequest.current) return;
    if (result.error) {
      setNotice(`Gagal memuat laporan: ${result.error.message}`);
    } else {
      const records = result.data || [];
      const rpcMissing = rankingResult.error?.code === "PGRST202";
      setReportHistory(records);
      setReportClassRanking(
        rankingResult.error
          ? buildMonthlyClassPrayerRanking(activeStudents, records, startDate, endDate, className)
          : rankingResult.data || [],
      );
      setNotice((current) => (rpcMissing && current.startsWith("Fungsi ranking") ? "" : current));
      setReportSyncScope({
        cursor,
        key: `report:${startDate}:${endDate}:${className}`,
        startDate,
        endDate,
        className,
      });
    }
    setReportLoading(false);
  }

  async function loadAttendanceCheckDate(date) {
    setAttendanceCheckDate(date);
    const requestId = ++attendanceCheckRequest.current;
    setAttendanceCheckLoading(true);
    const cursor = await fetchLatestSyncCursor();
    const result = await fetchAttendanceRows({ startDate: date, endDate: date });
    if (requestId !== attendanceCheckRequest.current) return;
    if (result.error) {
      setNotice(`Gagal memuat pengecekan absensi: ${result.error.message}`);
    } else {
      setAttendanceCheckRecords(result.data || []);
      setAttendanceCheckSyncScope({
        cursor,
        key: `check:${date}`,
        recordDate: date,
      });
    }
    setAttendanceCheckLoading(false);
  }

  function upsertAttendanceSlices(record) {
    if (
      (user?.role === "student" && String(record.studentId) === String(user.id)) ||
      record.date === todayKey
    ) {
      setAttendances((current) => upsertById(current, record));
    }
    if (
      reportSyncScope &&
      record.date >= reportSyncScope.startDate &&
      record.date <= reportSyncScope.endDate
    ) {
      setReportHistory((current) => upsertById(current, record));
    }
    if (attendanceCheckDate === record.date) {
      setAttendanceCheckRecords((current) => upsertById(current, record));
    }
  }

  function deleteAttendanceSlices(id) {
    const remove = (current) =>
      current.filter((record) => String(record.id) !== String(id));
    setAttendances(remove);
    setReportHistory(remove);
    setAttendanceCheckRecords(remove);
  }

  async function login(event) {
    event.preventDefault();
    if (loginInFlight.current) return;
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");
    setNotice("");
    loginInFlight.current = true;
    setLoggingIn(true);
    try {
      const { error } = await signInWithUsername(supabase, username, password);
      if (error) {
        setNotice(error);
        return;
      }
      // A legacy session kept for a retried migration is no longer needed.
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
      const { data } = await supabase.auth.getSession();
      await applySession(data.session, "login");
    } finally {
      loginInFlight.current = false;
      setLoggingIn(false);
    }
  }

  function logout() {
    return endSession("");
  }

  async function changePassword({ currentPassword, newPassword }) {
    const error = await changeOwnPassword(user.username, currentPassword, newPassword);
    if (error) return error;
    return user.role === "admin"
      ? "Password guru berhasil diubah."
      : "Password murid berhasil diubah.";
  }

  async function savePrayerSchedule(nextSchedule) {
    const { data, error } = await adminSetPrayerSchedule(nextSchedule);
    if (error || !data) return `Gagal menyimpan jadwal: ${error || "Jadwal tidak ditemukan."}`;
    setPrayerSchedule(mapPrayerSchedule(data));
    setScheduleReady(true);
    return null;
  }

  // Shows the row the server stored (its date and time), never a client-built one.
  function applyAttendanceRow(row) {
    attendanceWriteSeq.current += 1;
    upsertAttendanceSlices(mapAttendance(row));
  }

  async function recordAttendance(status, date = todayKey) {
    if (date > todayKey) {
      setAttendanceNotice("Absensi untuk tanggal mendatang belum tersedia.");
      return;
    }
    if (holidays.includes(date)) {
      setAttendanceNotice("Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.");
      return;
    }
    if (
      attendances.some(
        (item) => item.studentId === user.id && item.date === date,
      )
    )
      return;
    if (attendanceInFlight.current) return;
    attendanceInFlight.current = true;
    try {
      // Today's date is decided by the server; earlier dates are corrections.
      const { data, error } =
        date === todayKey
          ? await submitAttendance(status)
          : await submitLateAttendance(date, status);
      if (error || !data) {
        setAttendanceNotice(error || "Absensi tidak tersimpan. Coba lagi.");
        return;
      }
      setAttendanceNotice("");
      applyAttendanceRow(data);
    } finally {
      attendanceInFlight.current = false;
    }
  }

  function confirmPrayer() {
    return recordAttendance("Hadir");
  }

  function recordMenstruation(date = todayKey) {
    return recordAttendance("Haid", date);
  }

  function recordLateAttendance(date, status) {
    return recordAttendance(status, date);
  }

  async function toggleHoliday() {
    const isHoliday = holidays.includes(todayKey);
    const { error } = await adminSetHoliday(todayKey, !isHoliday);
    if (error) {
      setNotice(`Gagal mengubah status hari libur: ${error}`);
      return;
    }
    setHolidays((current) =>
      isHoliday
        ? current.filter((date) => date !== todayKey)
        : current.includes(todayKey)
          ? current
          : [...current, todayKey],
    );
    setNotice("");
  }

  async function markAttendanceAsAdmin(student, date, status, failureLabel) {
    const { data, error } = await adminMarkAttendance(student.id, date, status);
    if (error || !data) {
      setNotice(`${failureLabel}: ${error || "Absensi tidak tersimpan."}`);
      return;
    }
    setNotice("");
    applyAttendanceRow(data);
  }

  async function markStudentForDate(student, status, date) {
    if (date > todayKey) {
      setNotice("Absensi untuk tanggal mendatang belum tersedia.");
      return;
    }
    if (holidays.includes(date)) {
      setNotice("Tanggal tersebut ditetapkan sebagai hari libur. Absensi tidak tersedia.");
      return;
    }
    if (
      [...attendances, ...attendanceCheckRecords, ...reportHistory].some(
        (item) => item.studentId === student.id && item.date === date,
      )
    )
      return;
    await markAttendanceAsAdmin(student, date, status, "Gagal menandai absensi");
  }

  async function markStudentPresent(student) {
    if (holidays.includes(todayKey)) {
      setNotice("Hari ini ditetapkan sebagai hari libur. Absensi tidak tersedia.");
      return;
    }
    if (attendances.some((item) => item.studentId === student.id && item.date === todayKey)) return;
    await markAttendanceAsAdmin(student, todayKey, "Hadir", "Gagal menandai kehadiran");
  }

  async function markStudentMenstruation(student) {
    if (holidays.includes(todayKey)) {
      setNotice("Hari ini ditetapkan sebagai hari libur. Absensi tidak tersedia.");
      return;
    }
    if (student.gender !== "Perempuan") return;
    if (attendances.some((item) => item.studentId === student.id && item.date === todayKey)) return;
    await markAttendanceAsAdmin(student, todayKey, "Haid", "Gagal menandai haid");
  }

  async function saveStudent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const isEditing = Boolean(editing?.id);
    // PATCH replaces every field, so the edit form always sends all of them.
    const input = {
      nis: String(form.get("nis") || "").trim(),
      name: normalizeStudentName(form.get("name")),
      className: String(form.get("className") || ""),
      gender: String(form.get("gender") || ""),
      username: String(form.get("username") || "").trim(),
    };
    if (!isEditing) input.password = String(form.get("password") || "");
    if (studentSaveInFlight.current) return;
    studentSaveInFlight.current = true;
    const { data, error } = isEditing
      ? await updateStudent(editing.id, input)
      : await createStudent(input);
    studentSaveInFlight.current = false;
    if (error) {
      setNotice(`Gagal menyimpan data murid: ${error}`);
      return;
    }
    setNotice("");
    setStudents((current) => upsertById(current, mapStudent(data.student), false));
    setEditing(null);
  }

  function requestDelete(id) {
    setDeleteTarget(students.find((item) => item.id === id) || null);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    const { error } = await deactivateStudent(id);
    if (error) {
      setNotice(`Gagal menonaktifkan murid: ${error}`);
      setDeleteTarget(null);
      return;
    }
    setStudents((current) =>
      current.map((item) => (item.id === id ? { ...item, isActive: false } : item)),
    );
    setDeleteTarget(null);
  }

  async function resetPassword(student, password) {
    const { error } = await resetStudentPassword(student.id, password);
    if (error) return `Gagal mereset password: ${error}`;
    setNotice(`Password ${student.name} berhasil direset.`);
    return null;
  }

  function requestCancelAttendance(record) {
    setAttendanceDeleteTarget(record);
  }

  async function confirmCancelAttendance() {
    if (!attendanceDeleteTarget) return;
    const id = attendanceDeleteTarget.id;
    const { error } = await adminDeleteAttendance(id);
    if (error) {
      setNotice(`Gagal membatalkan status: ${error}`);
      return;
    }
    attendanceWriteSeq.current += 1;
    deleteAttendanceSlices(id);
    setAttendanceDeleteTarget(null);
  }

  if (!ready)
    return (
      <main className="session-loading">
        <div>
          <Logo />
          <DatabaseLoading label="Menyiapkan AbsensiSholat" />
        </div>
      </main>
    );
  if (!user) return <Login notice={notice} onLogin={login} pending={loggingIn} />;
  if (
    (attendanceLoading || accountDataLoading) &&
    (user.role === "student" || view === "dashboard")
  )
    return (
      <main className="session-loading">
        <div>
          <Logo />
          <DatabaseLoading label="Memuat absensi terbaru" />
        </div>
      </main>
    );
  if (user.role === "student") {
    // Fitur spinwheel dinonaktifkan karena tidak digunakan lagi.
    return (
      <>
        <StudentPage
           user={user}
           attendances={attendances}
           holidays={holidays}
           todayKey={todayKey}
          onConfirm={confirmPrayer}
           onHaid={recordMenstruation}
           onLateAttendance={recordLateAttendance}
           prayerSchedule={prayerSchedule}
           scheduleReady={scheduleReady}
            attendanceNotice={attendanceNotice}
            onDismissAttendanceNotice={() => setAttendanceNotice("")}
           onChangePassword={() => setPasswordModalOpen(true)}
          onLogout={logout}
        />
        {passwordModalOpen && (
          <PasswordModal
            role={user.role}
            onClose={() => setPasswordModalOpen(false)}
            onChangePassword={changePassword}
          />
        )}
      </>
    );
  }
  return (
    <>
      <AdminApp
       students={activeStudents}
       allStudents={students}
       attendances={todayAttendance}
       holidays={holidays}
       todayKey={todayKey}
       serverNow={serverNow}
      history={reportHistory}
      reportClassRanking={reportClassRanking}
      reportLoading={reportLoading}
      onReportRangeChange={loadReportRange}
      attendanceCheckRecords={attendanceCheckRecords}
      attendanceCheckDate={attendanceCheckDate}
      attendanceCheckLoading={attendanceCheckLoading}
      onAttendanceCheckDateChange={loadAttendanceCheckDate}
      view={view}
      setView={setView}
      query={query}
      setQuery={setQuery}
      classFilter={classFilter}
      setClassFilter={setClassFilter}
       filteredStudents={filteredStudents}
       notice={notice}
       editing={editing}
      setEditing={setEditing}
       onSave={saveStudent}
       onDelete={requestDelete}
       onResetPassword={resetPassword}
       onOpenPasswordChange={() => setPasswordModalOpen(true)}
        prayerSchedule={prayerSchedule}
        scheduleReady={scheduleReady}
        onSavePrayerSchedule={savePrayerSchedule}
       onCancelAttendance={requestCancelAttendance}
       onMarkStudentPresent={markStudentPresent}
       onMarkStudentMenstruation={markStudentMenstruation}
       onToggleHoliday={toggleHoliday}
       onMarkStudentForDate={markStudentForDate}
      onLogout={logout}
       />
      {passwordModalOpen && (
        <PasswordModal
          role={user.role}
          onClose={() => setPasswordModalOpen(false)}
          onChangePassword={changePassword}
        />
      )}
      {deleteTarget && (
        <DeleteConfirm
          student={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
      {attendanceDeleteTarget && (
        <CancelAttendanceConfirm
          attendance={attendanceDeleteTarget}
          onCancel={() => setAttendanceDeleteTarget(null)}
          onConfirm={confirmCancelAttendance}
        />
      )}
    </>
  );
}

function Login({ notice, onLogin, pending }) {
  return (
    <main className="login-shell">
      <section className="login-story">
        <Logo />
        <div>
          <p className="eyebrow">ABSENSI SHOLAT DZUHUR</p>
          <h1>Hadirkan kebiasaan baik, catat dengan sederhana.</h1>
          <p>
            Konfirmasi kehadiran setelah sholat Dzuhur dalam satu halaman yang
            mudah dipakai.
          </p>
        </div>
        <div className="story-note">
          <CheckCircle size={22} weight="fill" /> Satu QR tetap untuk semua
          murid
        </div>
      </section>
      <section className="login-panel">
        <form onSubmit={onLogin} className="login-form">
          <div className="mobile-login-brand">
            <Logo />
          </div>
          <h2>Selamat datang</h2>
          <p className="muted">
            Gunakan akun guru atau akun murid yang terdaftar.
          </p>
          {notice && (
            <p className="form-error">
              <WarningCircle size={18} />
              {notice}
            </p>
          )}
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              placeholder="Masukkan NIS Anda"
              required
            />
          </label>
          <label>
            Password
            <PasswordInput
              name="password"
              autoComplete="current-password"
              placeholder="Masukkan password"
              required
            />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? "Memproses..." : "Masuk ke aplikasi"}
          </button>
        </form>
      </section>
    </main>
  );
}

const wheelSegments = ["Sholat", "Tidak", "Tidak", "Tidak", "Tidak", "Tidak"];
const wheelColors = [
  "#176b45",
  "#f7f2e7",
  "#e4eee7",
  "#f7f2e7",
  "#e4eee7",
  "#f7f2e7",
];
const wheelGradient = `conic-gradient(from 0deg, ${wheelColors.map((color, i) => `${color} ${i * 60}deg ${i * 60 + 58}deg, #ffffff ${i * 60 + 58}deg ${(i + 1) * 60}deg`).join(", ")})`;

function SpinWheel({ user, onPass, onLogout, onChangePassword }) {
  const [rotation, setRotation] = useState(() =>
    Math.floor(Math.random() * 360),
  );
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const pendingRef = useRef(0);

  function spin() {
    if (spinning) return;
    const index = Math.floor(Math.random() * wheelSegments.length);
    const turns = 5 + Math.floor(Math.random() * 3);
    pendingRef.current = index;
    setResult(null);
    setSpinning(true);
    setRotation(rotation + turns * 360 + (330 - index * 60) - (rotation % 360));
  }

  function handleTransitionEnd(event) {
    if (event.propertyName !== "transform" || !spinning) return;
    setSpinning(false);
    setResult(
      wheelSegments[pendingRef.current] === "Sholat" ? "sholat" : "tidak",
    );
  }

  return (
    <main className="student-shell">
      <header>
        <Logo />
        <UserMenu
          name={user.name}
          onChangePassword={onChangePassword}
          onLogout={onLogout}
        />
      </header>
      <section className="confirm-card spin-card">
        <p className="eyebrow">PUTAR RODA DZUHUR</p>
        <h1>Putar roda, {user.name.split(" ")[0]}.</h1>
        <p className="muted">
          Hasil roda menentukan kamu bisa lanjut ke halaman Dzuhur atau tidak.
        </p>
        <div className="wheel-wrap">
          <div className="wheel-pointer" />
          <div
            className="wheel"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning
                ? "transform 4s cubic-bezier(.15,.75,.15,1)"
                : "none",
            }}
            onTransitionEnd={handleTransitionEnd}
          >
            <div className="wheel-face" style={{ background: wheelGradient }} />
            {wheelSegments.map((segment, i) => {
              const angle = i * 60 + 30;
              return (
                <div
                  key={i}
                  className="wheel-label"
                  style={{ transform: `rotate(${angle}deg)` }}
                >
                  <b
                    className={segment === "Sholat" ? "wheel-pass" : ""}
                    style={{ transform: "translateX(-50%) rotate(-90deg)" }}
                  >
                    {segment}
                  </b>
                </div>
              );
            })}
          </div>
          <button className="wheel-hub" onClick={spin} disabled={spinning}>
            {spinning ? "Memutar…" : "Putar"}
          </button>
        </div>
        {result === "sholat" ? (
          <div className="spin-result pass">
            <CheckCircle size={30} weight="fill" />
            <div>
              <strong>Sholat Dzuhur!</strong>
              <span>Kamu bisa melanjutkan konfirmasi kehadiran.</span>
            </div>
            <button className="primary" onClick={onPass}>
              Lanjut ke halaman Dzuhur
            </button>
          </div>
        ) : result === "tidak" ? (
          <div className="spin-result fail">
            <WarningCircle size={30} weight="fill" />
            <div>
              <strong>Belum sholat.</strong>
              <span>Kamu belum bisa masuk halaman Dzuhur hari ini.</span>
            </div>
            <div className="spin-actions">
              <button className="secondary" onClick={spin}>
                Putar lagi
              </button>
              <button className="text-button" onClick={onLogout}>
                Keluar
              </button>
            </div>
          </div>
        ) : null}
        <p className="privacy-note">
          Roda hanya dapat diputar sampai mendapat hasil Sholat.
        </p>
      </section>
    </main>
  );
}

function MenstruationPage({ user, onHaid, onContinue, onLogout }) {
  return (
    <main className="student-shell">
      <header>
        <Logo />
        <button className="text-button" onClick={onLogout}>
          Keluar <SignOut size={18} />
        </button>
      </header>
      <section className="confirm-card menstruation-card">
        <div className="prayer-icon menstruation-icon">♥</div>
        <p className="eyebrow">KONDISI HARI INI</p>
        <h1>Apakah kamu sedang haid?</h1>
        <p>
          {user.name} · Kelas {user.className}. Pilih kondisi yang sesuai untuk
          pencatatan hari ini.
        </p>
        <div className="menstruation-actions">
          <button className="haid-button large" onClick={onHaid}>
            Ya, sedang haid
          </button>
          <button className="primary large" onClick={onContinue}>
            Tidak, lanjutkan
          </button>
        </div>
        <p className="privacy-note">
          Pilihan haid akan dicatat sebagai status Haid dan melewati spinwheel.
        </p>
      </section>
    </main>
  );
}

function StudentPage({ user, attendances, holidays, todayKey, onConfirm, onHaid, onLateAttendance, attendanceNotice, onDismissAttendanceNotice, onLogout, onChangePassword, prayerSchedule, scheduleReady }) {
  const [timeNotice, setTimeNotice] = useState(null);
  const [haidConfirmationOpen, setHaidConfirmationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isHoliday = holidays.includes(todayKey);
  const recorded = attendances.find(
    (item) => item.studentId === user.id && item.date === todayKey,
  );
  async function validateConfirmationTime() {
    const result = await fetchPrayerSchedule();
    if (result.error || !result.schedule) {
      setTimeNotice({
        title: "Jadwal belum tersedia",
        message: "Gagal memuat jadwal terbaru. Coba lagi beberapa saat.",
      });
      return false;
    }
    const schedule = result.schedule;
    if (!schedule.enabled) return true;
    const minutes = jakartaMinutesNow();
    const startMinutes = timeToMinutes(schedule.start);
    const endMinutes = timeToMinutes(schedule.end);
    if (minutes < startMinutes) {
      setTimeNotice({
        title: "Konfirmasi belum dibuka",
        message: `Konfirmasi sholat Dzuhur tersedia mulai pukul ${schedule.start.replace(":", ".")} WIB.`,
      });
      return false;
    }
    if (minutes > endMinutes) {
      setTimeNotice({
        title: "Waktu konfirmasi sudah terlewat",
        message: `Waktu konfirmasi berakhir pukul ${schedule.end.replace(":", ".")} WIB. Harap konfirmasi ke guru bila terjadi kesalahan.`,
      });
      return false;
    }
    return true;
  }
  async function handleConfirmation() {
    if (!(await validateConfirmationTime())) return;
    onConfirm();
  }
  async function handleMenstruation() {
    if (!(await validateConfirmationTime())) return;
    setHaidConfirmationOpen(true);
  }
  function confirmMenstruation() {
    setHaidConfirmationOpen(false);
    onHaid();
  }
  if (settingsOpen) {
    return (
      <StudentSettingsPage
        user={user}
        attendances={attendances}
        holidays={holidays}
        todayKey={todayKey}
        onBack={() => setSettingsOpen(false)}
        onChangePassword={onChangePassword}
        onLateAttendance={onLateAttendance}
        attendanceStartDate={prayerSchedule.attendanceStartDate}
        attendanceNotice={attendanceNotice}
        onDismissAttendanceNotice={onDismissAttendanceNotice}
        onLogout={onLogout}
      />
    );
  }
  return (
    <main className="student-shell">
      <header>
        <Logo />
          <UserMenu
            name={user.name}
            onChangePassword={onChangePassword}
            onOpenSettings={() => setSettingsOpen(true)}
            onLogout={onLogout}
            disabled={Boolean(timeNotice || haidConfirmationOpen || attendanceNotice)}
          />
      </header>
      <section className="confirm-card">
        <div className="prayer-icon">
          <CheckCircle size={34} weight="bold" />
        </div>
        {recorded ? (
          <>
            <p className="eyebrow">SUDAH TERCATAT</p>
            <h1>Terima kasih, {user.name.split(" ")[0]}.</h1>
            <p>
              {recorded.status === "Haid"
                ? "Status haid Anda tercatat"
                : "Absensi sholat Dzuhur Anda tercatat"} pukul{" "}
              <strong>{recorded.time}</strong>.
            </p>
          </>
        ) : isHoliday ? (
          <>
            <p className="eyebrow">HARI LIBUR</p>
            <h1>Tidak ada absensi hari ini.</h1>
            <p>Hari ini ditetapkan sebagai hari libur oleh guru.</p>
          </>
        ) : (
          <>
            <p className="eyebrow">KONFIRMASI DZUHUR</p>
            <h1>Apakah Anda sudah sholat Dzuhur?</h1>
            <p>
              {user.name} · Kelas {user.className}
            </p>
            <div className="student-confirm-actions">
              <button className="primary large" onClick={handleConfirmation}>
                Saya sudah sholat Dzuhur
              </button>
              {user.gender === "Perempuan" && (
                <button className="haid-button large" onClick={handleMenstruation}>
                  Tidak, saya sedang Haid
                </button>
              )}
            </div>
          </>
        )}
        <p className="privacy-note">
          Konfirmasi hanya dapat dilakukan satu kali setiap hari.
        </p>
      </section>
      <footer className="student-footer">© 2026. Created by @irfanqs</footer>
      {attendanceNotice && (
        <div
          className="modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="attendance-error-title"
        >
          <section className="student-modal time-notice">
            <WarningCircle size={32} weight="fill" />
            <div>
              <h2 id="attendance-error-title">Absensi gagal disimpan</h2>
            </div>
            <p>{attendanceNotice}</p>
            <button className="primary" onClick={onDismissAttendanceNotice}>
              Mengerti
            </button>
          </section>
        </div>
      )}
      {timeNotice && (
        <div
          className="modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="time-notice-title"
        >
          <section className="student-modal time-notice">
            <WarningCircle size={32} weight="fill" />
            <div>
              <h2 id="time-notice-title">{timeNotice.title}</h2>
            </div>
            <p>{timeNotice.message}</p>
            <button className="primary" onClick={() => setTimeNotice(null)}>
              Mengerti
            </button>
          </section>
        </div>
      )}
      {haidConfirmationOpen && (
        <div
          className="modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="haid-confirmation-title"
        >
          <section className="student-modal time-notice">
            <WarningCircle size={32} weight="fill" />
            <div>
              <h2 id="haid-confirmation-title">Konfirmasi status haid</h2>
            </div>
            <p>
              Pastikan Anda benar-benar sedang haid. Status ini akan dicatat
              sebagai Haid dan tidak dapat diubah hari ini.
            </p>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setHaidConfirmationOpen(false)}
              >
                Batal
              </button>
              <button className="haid-button" onClick={confirmMenstruation}>
                Ya, saya sedang haid
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function StudentSettingsPage({ user, attendances, holidays, todayKey, onBack, onChangePassword, onLateAttendance, attendanceStartDate, attendanceNotice, onDismissAttendanceNotice, onLogout }) {
  const [month, setMonth] = useState(() => {
    const current = new Date(todayKey + "T12:00:00");
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [correctionDate, setCorrectionDate] = useState(null);
  const [correctionMode, setCorrectionMode] = useState(null);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const attendanceByDate = new Map(
    attendances
      .filter((item) => item.studentId === user.id)
      .map((item) => [item.date, item]),
  );
  const calendarDays = Array.from({ length: firstDay + daysInMonth }, (_, index) =>
    index < firstDay ? null : index - firstDay + 1,
  );
  const monthLabel = month.toLocaleDateString("id-ID", {
    month: "long",
    year: "numeric",
  });
  function shiftMonth(amount) {
    setMonth(new Date(year, monthIndex + amount, 1));
  }
  function closeCorrectionModal() {
    setCorrectionDate(null);
    setCorrectionMode(null);
  }
  function submitCorrection(status) {
    if (!correctionDate) return;
    onLateAttendance(correctionDate, status);
    closeCorrectionModal();
  }
  function recordLabel(record) {
    if (!record) return "";
    if (record.status === "Haid") return "Haid";
    if (record.status === "Terlambat") return "Telat";
    return "Hadir";
  }
  return (
    <main className="student-shell student-settings-shell">
      <header>
        <Logo />
        <UserMenu
          name={user.name}
          onChangePassword={onChangePassword}
          onLogout={onLogout}
        />
      </header>
      <section className="student-settings-card">
        <button
          className="student-settings-back"
          onClick={onBack}
          aria-label="Kembali ke absensi"
        >
          <ArrowLeft size={22} />
        </button>
        <p className="eyebrow">PENGATURAN SISWA</p>
        <h1>Kalender absensi</h1>
        <p className="muted">
          Cek riwayat konfirmasi sholat dan status haid Anda.
        </p>
        <div className="student-calendar">
          <div className="student-calendar-head">
            <button className="calendar-nav" onClick={() => shiftMonth(-1)} aria-label="Bulan sebelumnya">
              ‹
            </button>
            <strong>{monthLabel}</strong>
            <button className="calendar-nav" onClick={() => shiftMonth(1)} aria-label="Bulan berikutnya">
              ›
            </button>
          </div>
          <div className="student-calendar-weekdays">
            {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="student-calendar-grid">
            {calendarDays.map((day, index) => {
              if (!day) return <span className="calendar-day calendar-day-empty" key={`empty-${index}`} />;
              const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const record = attendanceByDate.get(date);
              const isHoliday = holidays.includes(date);
              const isToday = date === todayKey;
              // Same bounds as submit_late_attendance: start date <= date < today.
              const canCorrect =
                !record && !isHoliday && date >= attendanceStartDate && date < todayKey;
              const statusClass = record
                ? record.status === "Haid"
                  ? "haid"
                  : record.status === "Terlambat"
                    ? "late"
                    : "hadir"
                : "";
              return (
                <button
                  type="button"
                  className={`calendar-day${isToday ? " calendar-day-today" : ""}${isHoliday ? " calendar-day-holiday" : statusClass ? ` calendar-day-${statusClass}` : ""}${canCorrect ? " calendar-day-clickable" : ""}`}
                  key={date}
                  onClick={() => canCorrect && setCorrectionDate(date)}
                  disabled={!canCorrect}
                  aria-label={canCorrect ? `Perbaiki absensi tanggal ${day}` : undefined}
                >
                  {day}
                  {isHoliday ? <small>Libur</small> : record && <small>{recordLabel(record)}</small>}
                </button>
              );
            })}
          </div>
          <div className="student-calendar-legend">
            <span><i className="calendar-dot calendar-dot-hadir" /> Hadir</span>
            <span><i className="calendar-dot calendar-dot-late" /> Telat</span>
            <span><i className="calendar-dot calendar-dot-haid" /> Haid</span>
            <span><i className="calendar-dot calendar-dot-holiday" /> Libur</span>
            <span><i className="calendar-dot calendar-dot-empty" /> Belum tercatat</span>
          </div>
        </div>
      </section>
      {correctionDate && (
        <div className="modal-backdrop" role="presentation" onClick={closeCorrectionModal}>
          <section
            className="student-modal correction-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="correction-title"
            onClick={(event) => event.stopPropagation()}
          >
            {!correctionMode ? (
              <>
                <h2 id="correction-title">Perbaiki absensi?</h2>
                <p className="muted">Apakah anda ingin memperbaiki absensi pada tanggal {new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${correctionDate}T12:00:00`))}?</p>
                <button className="primary" onClick={() => setCorrectionMode("late")}>Saya sudah sholat tapi lupa absen</button>
                {user.gender === "Perempuan" && (
                  <button className="haid-button" onClick={() => setCorrectionMode("haid")}>Saya sedang haid</button>
                )}
                <button className="secondary" onClick={closeCorrectionModal}>Batal</button>
              </>
            ) : (
              <>
                <WarningCircle size={32} weight="fill" />
                <h2 id="correction-title">Konfirmasi absensi {correctionMode === "haid" ? "haid" : "terlambat"}</h2>
                <p className="muted">
                  {correctionMode === "haid"
                    ? "Status haid akan disimpan untuk tanggal yang dipilih dan tidak dapat diisi ulang."
                    : "Data absen sholat akan disimpan untuk tanggal yang dipilih, tetapi dinyatakan telat karena tidak diisi pada waktunya."}
                </p>
                <div className="modal-actions">
                  <button className="secondary" onClick={() => setCorrectionMode(null)}>Tidak</button>
                  <button className={correctionMode === "haid" ? "haid-button" : "primary"} onClick={() => submitCorrection(correctionMode === "haid" ? "Haid" : "Terlambat")}>Setuju</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {attendanceNotice && (
        <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="settings-attendance-error-title">
          <section className="student-modal time-notice">
            <WarningCircle size={32} weight="fill" />
            <h2 id="settings-attendance-error-title">Absensi gagal disimpan</h2>
            <p>{attendanceNotice}</p>
            <button className="primary" onClick={onDismissAttendanceNotice}>Mengerti</button>
          </section>
        </div>
      )}
    </main>
  );
}

function AdminApp(props) {
  const {
    students,
    allStudents,
    attendances,
    holidays,
    history,
    reportClassRanking,
    reportLoading,
    onReportRangeChange,
    attendanceCheckRecords,
    attendanceCheckDate,
    attendanceCheckLoading,
    onAttendanceCheckDateChange,
    view,
    setView,
    query,
    setQuery,
    classFilter,
    setClassFilter,
    filteredStudents,
    notice,
    editing,
    setEditing,
    onSave,
    onDelete,
    onResetPassword,
    onOpenPasswordChange,
    onCancelAttendance,
    onMarkStudentPresent,
    onMarkStudentMenstruation,
    onToggleHoliday,
    onMarkStudentForDate,
    todayKey,
    serverNow,
    prayerSchedule,
    scheduleReady,
    onSavePrayerSchedule,
    onLogout,
  } = props;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const selectView = (nextView) => {
    setView(nextView);
    setMobileMenuOpen(false);
  };
  const present = attendances.length;
  const absent = students.length - present;
  const standardClassOptions = [
    ...["X", "XI", "XII"].flatMap((level) =>
      Array.from({ length: 12 }, (_, index) => `${level}-${String(index + 1).padStart(2, "0")}`),
    ),
  ];
  const classOptions = [...new Set([
    ...standardClassOptions,
    ...students.map((student) => student.className).filter(Boolean),
  ])].sort((first, second) => first.localeCompare(second, "id", { numeric: true }));
  return (
    <div className="app-shell">
      <aside className={mobileMenuOpen ? "menu-open" : ""}>
        <div className="mobile-nav-head">
          <Logo />
          <button
            className="mobile-menu-toggle"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Tutup menu" : "Buka menu"}
          >
            {mobileMenuOpen ? <X size={22} /> : <List size={22} />}
          </button>
        </div>
        <nav>
          <NavButton
            active={view === "dashboard"}
            onClick={() => selectView("dashboard")}
            icon={<House size={20} />}
          >
            Ringkasan
          </NavButton>
          <NavButton
            active={view === "reports"}
            onClick={() => selectView("reports")}
            icon={<CalendarBlank size={20} />}
          >
            Rekap Absensi
          </NavButton>
          <NavButton
            active={view === "attendance-check"}
            onClick={() => selectView("attendance-check")}
            icon={<ClipboardText size={20} />}
          >
            Cek Absensi
          </NavButton>
          <NavButton
            active={view === "students"}
            onClick={() => selectView("students")}
            icon={<UsersThree size={20} />}
          >
             Data Murid
          </NavButton>
          <NavButton
            active={view === "qr"}
            onClick={() => selectView("qr")}
            icon={<QrCode size={20} />}
          >
            QR Dzuhur
          </NavButton>
          <NavButton
            active={view === "settings"}
            onClick={() => selectView("settings")}
            icon={<Gear size={20} />}
          >
            Pengaturan
          </NavButton>
        </nav>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div>
            {view === "dashboard" && <p className="eyebrow">{formatDate()}</p>}
            <h1>
              {view === "dashboard"
                 ? "Ringkasan Hari Ini"
                 : view === "reports"
                   ? "Rekap Absensi"
                  : view === "students"
                    ? "Data Murid"
                    : view === "attendance-check"
                      ? "Cek Absensi"
                      : view === "qr"
                        ? "QR Sholat Dzuhur"
                        : "Pengaturan"}
            </h1>
          </div>
        </header>
        {notice && <p className="admin-notice">{notice}</p>}
        {view === "dashboard" && (
          <Dashboard
            present={present}
            absent={absent}
            total={students.length}
            students={students}
            classOptions={classOptions}
            attendances={attendances}
            totalStudents={students.length}
            totalConfirmed={attendances.length}
            onCancelAttendance={onCancelAttendance}
            onMarkStudentPresent={onMarkStudentPresent}
            onMarkStudentMenstruation={onMarkStudentMenstruation}
            todayKey={todayKey}
            isHoliday={holidays.includes(todayKey)}
            onToggleHoliday={onToggleHoliday}
          />
        )}
        {view === "reports" && (
          <ReportPage
            students={allStudents}
            history={history}
            classRanking={reportClassRanking}
            loading={reportLoading}
            onRangeChange={onReportRangeChange}
          />
        )}
        {view === "attendance-check" && (
          <AttendanceCheckPage
            students={students}
            history={attendanceCheckRecords}
            holidays={holidays}
            todayKey={todayKey}
            selectedDate={attendanceCheckDate}
            loading={attendanceCheckLoading}
            onDateChange={onAttendanceCheckDateChange}
            onMarkStudentForDate={onMarkStudentForDate}
            onCancelAttendance={onCancelAttendance}
          />
        )}
        {view === "students" && (
          <Students
            students={filteredStudents}
            allStudents={allStudents}
            classOptions={classOptions}
            query={query}
            setQuery={setQuery}
            classFilter={classFilter}
            setClassFilter={setClassFilter}
            setEditing={setEditing}
            onDelete={onDelete}
            onResetPassword={onResetPassword}
          />
        )}
        {view === "qr" && <QrPage />}
        {view === "settings" && (
          <SettingsPage
            onLogout={onLogout}
            onChangePassword={onOpenPasswordChange}
            prayerSchedule={prayerSchedule}
            scheduleReady={scheduleReady}
            onSavePrayerSchedule={onSavePrayerSchedule}
            serverNow={serverNow}
          />
        )}
      </main>
      {editing !== null && (
        <StudentModal
          student={editing}
          classOptions={classOptions}
          onClose={() => setEditing(null)}
          onSave={onSave}
        />
      )}
    </div>
  );
}
function NavButton({ active, onClick, icon, children }) {
  return (
    <button onClick={onClick} className={active ? "nav-active" : ""}>
      {icon}
      {children}
    </button>
  );
}

function UserMenu({ name, onChangePassword, onOpenSettings, onLogout, disabled = false }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="user-menu">
      <button
        className="user-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Buka menu pengguna"
        disabled={disabled}
      >
        <UserCircle size={32} weight="regular" />
      </button>
      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-name">{name}</div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onChangePassword();
            }}
          >
             Ganti Password
          </button>
          {onOpenSettings && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Kalender Absensi
            </button>
          )}
          <button
            role="menuitem"
            className="user-menu-logout"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
             Keluar <SignOut size={17} />
          </button>
        </div>
      )}
    </div>
  );
}

function Dashboard({ students, classOptions, attendances, totalStudents, totalConfirmed, todayKey, isHoliday, onToggleHoliday, onCancelAttendance, onMarkStudentPresent, onMarkStudentMenstruation }) {
  const [selectedClass, setSelectedClass] = useState("Semua kelas");
  const [searchQuery, setSearchQuery] = useState("");
  const [dashboardFilter, setDashboardFilter] = useState("all");
  const visibleStudents = students.filter(
    (student) => selectedClass === "Semua kelas" || student.className === selectedClass,
  );
  const visibleAttendances = attendances.filter(
    (item) => selectedClass === "Semua kelas" || item.className === selectedClass,
  );
  const confirmedCount = visibleAttendances.length;
  const haidCount = visibleAttendances.filter((item) => item.status === "Haid").length;
  const absent = visibleStudents.length - confirmedCount;
  const sholatCount = attendances.filter((item) => item.status !== "Haid").length;
  const schoolHaidCount = attendances.filter((item) => item.status === "Haid").length;
  const sholatPercentage = totalStudents
    ? Number(((sholatCount / totalStudents) * 100).toFixed(1))
    : 0;
  const haidPercentage = totalStudents
    ? Number(((schoolHaidCount / totalStudents) * 100).toFixed(1))
    : 0;
  const pendingPercentage = Number((100 - sholatPercentage - haidPercentage).toFixed(1));
  const absentStudents = visibleStudents.filter(
    (student) => !visibleAttendances.some((item) => item.studentId === student.id),
  );
  const filteredAbsentStudents = absentStudents.filter((student) =>
    `${student.name} ${student.username} ${student.className}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );
  const filteredAttendances = visibleAttendances.filter((item) =>
    `${item.studentName} ${item.className} ${item.status || "Hadir"}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );
  const filterKey = `${selectedClass}|${searchQuery}`;
  const absentPage = usePagination(filteredAbsentStudents, filterKey);
  const attendancePage = usePagination(filteredAttendances, filterKey);
  return (
    <>
      <button className={`holiday-toggle${isHoliday ? " holiday-active" : ""}`} onClick={onToggleHoliday}>
        <CalendarBlank size={19} />
        {isHoliday ? "Batalkan hari libur" : "Jadikan hari ini libur"}
      </button>
      <section className="dashboard-insight">
        <div
          className="attendance-pie"
          style={{
            background: `conic-gradient(var(--green) 0 ${sholatPercentage}%, #efb0aa ${sholatPercentage}% ${sholatPercentage + haidPercentage}%, #f2d77c ${sholatPercentage + haidPercentage}% 100%)`,
          }}
        >
          <div>
            <strong>{sholatPercentage}%</strong>
            <span>sholat</span>
          </div>
        </div>
        <div className="attendance-legend">
          <p className="eyebrow">PERSENTASE HARI INI</p>
          <h2>Progress konfirmasi</h2>
           <span><i className="legend-dot legend-present" /> Sholat <b>{sholatPercentage}%</b></span>
           <span><i className="legend-dot legend-haid" /> Haid <b>{haidPercentage}%</b></span>
           <span><i className="legend-dot legend-pending" /> Belum absen <b>{pendingPercentage}%</b></span>
        </div>
      </section>
      <section className="metric-grid">
        <Metric
          label="Sudah hadir"
          value={confirmedCount}
          detail="Murid terkonfirmasi"
          tone="green"
          active={dashboardFilter === "confirmed"}
          onClick={() => setDashboardFilter("confirmed")}
        />
        <Metric
          label="Belum hadir"
          value={absent}
          detail="Perlu ditinjau"
          tone="sand"
          active={dashboardFilter === "pending"}
          onClick={() => setDashboardFilter("pending")}
        />
        <Metric
          label="Total murid"
          value={visibleStudents.length}
          detail="Dari 36 kelas"
          tone="plain"
          active={dashboardFilter === "all"}
          onClick={() => setDashboardFilter("all")}
        />
      </section>
      <div className="dashboard-search-row">
        <label className="dashboard-search">
          <MagnifyingGlass size={19} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={
              dashboardFilter === "confirmed"
                  ? "Cari nama murid yang sudah hadir..."
                  : dashboardFilter === "pending"
                    ? "Cari nama murid yang belum hadir..."
                  : "Cari nama murid..."
            }
          />
        </label>
        <select
          className="dashboard-class-filter"
          value={selectedClass}
          onChange={(event) => setSelectedClass(event.target.value)}
        >
          <option>Semua kelas</option>
          {classOptions.map((className) => <option key={className}>{className}</option>)}
        </select>
      </div>
      {(dashboardFilter === "pending" || dashboardFilter === "all") && absentStudents.length > 0 && (
        <section className="unconfirmed-panel">
          <div className="panel-title">
            <div>
              <h2>Belum konfirmasi</h2>
              <p>Guru dapat menandai murid yang sudah hadir secara langsung.</p>
            </div>
            <span>{absentStudents.length} murid</span>
          </div>
          <div className="unconfirmed-list">
            {absentPage.items.map((student, index) => (
              <div key={student.id}>
                <span className="person-initial attendance-number">
                  {absentPage.offset + index + 1}
                </span>
                <div>
                  <strong>{student.name}</strong>
                  <span>Kelas {student.className}</span>
                </div>
                <div className="unconfirmed-actions">
                  <button
                    className="mark-present-button"
                    onClick={() => onMarkStudentPresent(student)}
                    disabled={isHoliday}
                  >
                    Tandai hadir
                  </button>
                  {student.gender === "Perempuan" && (
                    <button
                      className="mark-present-button mark-haid-button"
                      onClick={() => onMarkStudentMenstruation(student)}
                      disabled={isHoliday}
                    >
                      Tandai haid
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Pagination pagination={absentPage} />
          {!filteredAbsentStudents.length && (
            <div className="empty">Murid tidak ditemukan.</div>
          )}
        </section>
      )}
      {(dashboardFilter === "confirmed" || dashboardFilter === "all") && <section className="attendance-panel">
        <div className="panel-title">
          <div>
            <h2>Absensi terbaru</h2>
            <p>Konfirmasi yang masuk hari ini.</p>
          </div>
          <span>
            {confirmedCount} murid terkonfirmasi{haidCount ? ` · ${haidCount} haid` : ""}
          </span>
        </div>
        {filteredAttendances.length ? (
          <>
          <div className="attendance-list">
            {attendancePage.items.map((item, index) => (
              <div key={item.id}>
                <span className="person-initial attendance-number">{attendancePage.offset + index + 1}</span>
                <div className="attendance-person">
                  <strong>{item.studentName}</strong>
                  <span className="attendance-class">
                    Kelas {item.className}
                  </span>
                </div>
                <div className="attendance-meta">
                  <b className={item.status === "Haid" ? "status-badge status-haid" : item.status === "Terlambat" ? "status-badge status-late" : "status-badge status-hadir"}>
                    {item.status || "Hadir"}
                  </b>
                  <time>{item.time}</time>
                  <button
                    className="cancel-attendance"
                    aria-label={`Batalkan status ${item.studentName}`}
                    onClick={() => onCancelAttendance(item)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Pagination pagination={attendancePage} />
          </>
        ) : (
          <div className="empty">
            <CheckCircle size={28} />
            Belum ada konfirmasi Dzuhur hari ini.
          </div>
        )}
      </section>}
    </>
  );
}
function ReportPage({ students, history, classRanking, loading, onRangeChange }) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(new Date());
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [selectedClass, setSelectedClass] = useState("Semua kelas");
  const [reportFilter, setReportFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showRanking, setShowRanking] = useState(false);
  const referenceDate = new Date(`${selectedMonth}-01T12:00:00`);
  const rangeStart = `${selectedMonth}-01`;
  const rangeEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
  // Active students plus deactivated ones with attendance this period; used for
  // class options, percentages, the pending list and the xlsx export alike.
  const periodStudents = useMemo(
    () => selectReportStudents(students, history, { startDate: rangeStart, endDate: rangeEnd }),
    [students, history, rangeStart, rangeEnd],
  );
  const classOptions = [...new Set(periodStudents.map((student) => student.className).filter(Boolean))].sort();
  const requestRange = useEffectEvent(onRangeChange);
  useEffect(() => {
    requestRange(rangeStart, rangeEnd, selectedClass);
  }, [rangeStart, rangeEnd, selectedClass]);
  const records = useMemo(() => {
    return history
      .filter((item) => {
        return (
          item.date.startsWith(selectedMonth) &&
          (selectedClass === "Semua kelas" || item.className === selectedClass)
        );
      })
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }, [history, selectedMonth, selectedClass]);
  const selectedStudents = periodStudents.filter(
    (student) => selectedClass === "Semua kelas" || student.className === selectedClass,
  );
  const periodDays = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0).getDate();
  const expectedAttendance = selectedStudents.length * periodDays;
  const periodDates = Array.from({ length: periodDays }, (_, index) => {
    const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), index + 1);
    return date.toISOString().slice(0, 10);
  });
  const sholatRecords = records.filter((item) => item.status !== "Haid").length;
  const haidRecords = records.filter((item) => item.status === "Haid").length;
  const unrecordedAttendance = Math.max(expectedAttendance - records.length, 0);
  const reportSholatPercentage = expectedAttendance
    ? Number(((sholatRecords / expectedAttendance) * 100).toFixed(1))
    : 0;
  const reportHaidPercentage = expectedAttendance
    ? Number(((haidRecords / expectedAttendance) * 100).toFixed(1))
    : 0;
  const reportPendingPercentage = expectedAttendance
    ? Number(((unrecordedAttendance / expectedAttendance) * 100).toFixed(1))
    : 0;
  const monthlyLabel = referenceDate.toLocaleDateString("id-ID", {
    month: "long",
    year: "numeric",
  });
  const pendingRecords = reportFilter === "pending"
    ? selectedStudents.flatMap((student) =>
        periodDates
          .filter(
            (date) => !records.some((item) => item.studentId === student.id && item.date === date),
          )
          .map((date) => ({
            id: `pending-${student.id}-${date}`,
            studentName: student.name,
            className: student.className,
            date,
            status: "Tidak Sholat",
            pending: true,
          })),
      )
    : [];
  const displayedRecords = reportFilter === "sholat"
    ? records.filter((item) => item.status !== "Haid")
    : reportFilter === "haid"
      ? records.filter((item) => item.status === "Haid")
      : reportFilter === "pending"
        ? pendingRecords
        : records;
  const searchedRecords = displayedRecords.filter((item) =>
    `${item.studentName} ${item.className} ${item.status}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );
  const recordPage = usePagination(
    searchedRecords,
    `${selectedMonth}|${selectedClass}|${reportFilter}|${searchQuery}`,
  );
  const rankedClasses = (classRanking || []).filter((item) =>
    item.className.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const highestRanking = classRanking?.[0];
  const lowestRanking = classRanking?.length ? classRanking[classRanking.length - 1] : null;
  async function exportReport() {
    const XLSX = await import("xlsx-js-style");
    const exportClasses = selectedClass === "Semua kelas" ? classOptions : [selectedClass];
    const workbook = XLSX.utils.book_new();
    const periodLabel = monthlyLabel;
    const title = "DAFTAR PELAKSANAAN SHOLAT DZUHUR";
    const subtitle = "SISWA-SISWI SMAN 9 SEMARANG";

    exportClasses.forEach((className) => {
      const classStudents = periodStudents
        .filter((student) => student.className === className)
        .sort((first, second) => first.name.localeCompare(second.name, "id", { sensitivity: "base" }));
      const dates = periodDates;
      const attendanceByStudentDate = new Map(
        history
          .filter((item) => item.className === className && dates.includes(item.date))
          .map((item) => [`${item.studentId}-${item.date}`, item]),
      );
      const rows = [
        [title],
        [subtitle],
        [`PERIODE: ${periodLabel.toUpperCase()}`],
        [`KELAS: ${className}`],
        [],
        ["NO", "NAMA", ...dates.map((date) => String(Number(date.slice(8, 10)))), "JUMLAH"],
      ];
      classStudents.forEach((student, index) => {
        let total = 0;
        rows.push([
          index + 1,
          student.name,
          ...dates.map((date) => {
            const record = attendanceByStudentDate.get(`${student.id}-${date}`);
            if (!record) return "X";
            if (record.status === "Haid") return "H";
            total += 1;
            return record.status === "Terlambat" ? "T" : "✓";
          }),
          total,
        ]);
      });
      rows.push([
        "Jumlah",
        "Sholat",
        ...dates.map((date) =>
          classStudents.filter((student) => {
            const record = attendanceByStudentDate.get(`${student.id}-${date}`);
            return record && record.status !== "Haid";
          }).length,
        ),
        "",
      ]);
      rows.push([
        "",
        "Tidak Sholat",
        ...dates.map((date) =>
          classStudents.filter((student) => !attendanceByStudentDate.has(`${student.id}-${date}`)).length,
        ),
        "",
      ]);
      rows.push([]);
      rows.push(["NB: ✓ = absen normal, T = absen terlambat, H = haid, X = tidak/belum melaksanakan sholat dzuhur."]);

      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      const lastColumn = dates.length + 2;
      const tableStartRow = 5;
      const tableEndRow = rows.length - 3;
      const thinBorder = {
        top: { style: "thin", color: { rgb: "000000" } },
        right: { style: "thin", color: { rgb: "000000" } },
        bottom: { style: "thin", color: { rgb: "000000" } },
        left: { style: "thin", color: { rgb: "000000" } },
      };
      worksheet["!merges"] = [0, 1, 2, 3].map((row) => ({
        s: { r: row, c: 0 },
        e: { r: row, c: lastColumn },
      }));
      for (let row = 0; row <= 3; row += 1) {
        const cellRef = XLSX.utils.encode_cell({ r: row, c: 0 });
        worksheet[cellRef].s = {
          font: { bold: true },
          alignment: { horizontal: "center", vertical: "center" },
        };
      }
      for (let row = tableStartRow; row <= tableEndRow; row += 1) {
        for (let col = 0; col <= lastColumn; col += 1) {
          const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
          if (!worksheet[cellRef]) worksheet[cellRef] = { t: "s", v: "" };
          worksheet[cellRef].s = {
            border: thinBorder,
            alignment: {
              horizontal: col === 1 ? "left" : "center",
              vertical: "center",
              wrapText: true,
            },
            font: { bold: row === tableStartRow || row > tableEndRow - 2 },
            fill: row === tableStartRow
              ? { fgColor: { rgb: "E6E6E6" } }
              : rows[row]?.[col] === "T"
                ? { fgColor: { rgb: "FFF2CC" } }
                : undefined,
          };
        }
      }
      worksheet["!cols"] = [
        { wch: 5 },
        { wch: 32 },
        ...dates.map(() => ({ wch: 5 })),
        { wch: 8 },
      ];
      XLSX.utils.book_append_sheet(workbook, worksheet, className.slice(0, 31));
    });

    const fileClass = selectedClass === "Semua kelas" ? "semua-kelas" : selectedClass.replace(/\s+/g, "-");
    XLSX.writeFile(workbook, `rekap-dzuhur-${fileClass}-${rangeStart}-${rangeEnd}.xlsx`);
  }
  if (loading) {
    return (
      <section className="report-panel empty">
        <DatabaseLoading label="Memuat data laporan..." />
      </section>
    );
  }
  return (
    <section className="report-panel">
      <div className="report-controls">
        <label>
          Bulan rekap
          <input
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          />
        </label>
        <label>
          Kelas
          <select
            value={selectedClass}
            onChange={(event) => setSelectedClass(event.target.value)}
          >
            <option>Semua kelas</option>
            {classOptions.map((className) => (
              <option key={className}>{className}</option>
            ))}
          </select>
        </label>
        <button className="secondary report-export" onClick={exportReport}>
          <DownloadSimple size={18} />
          Download Rekap Per Kelas
        </button>
      </div>
      <div className="report-summary">
        <p>
          {`Rekap bulanan ${monthlyLabel}. Pilih kelas lalu download Excel dengan format tabel per tanggal.`}
        </p>
        <button
          className={`report-metric report-metric-sholat${reportFilter === "sholat" ? " active" : ""}`}
          onClick={() => setReportFilter("sholat")}
        >
          <span>Konfirmasi sholat</span>
          <strong>{sholatRecords}</strong>
        </button>
        <button
          className={`report-metric report-metric-haid${reportFilter === "haid" ? " active" : ""}`}
          onClick={() => setReportFilter("haid")}
        >
          <span>Haid</span>
          <strong>{haidRecords}</strong>
        </button>
        <button
          className={`report-metric report-metric-pending${reportFilter === "pending" ? " active" : ""}`}
          onClick={() => setReportFilter("pending")}
        >
          <span>Tidak sholat</span>
          <strong>{unrecordedAttendance}</strong>
        </button>
        <div className="ranking-highlight">
          <div>
            <span>Kelas paling rajin sholat</span>
            <strong>{highestRanking ? `${highestRanking.className} · ${highestRanking.percentage}%` : "-"}</strong>
          </div>
          <div>
            <span>Kelas paling sering tidak sholat</span>
            <strong>{lowestRanking ? `${lowestRanking.className} · ${lowestRanking.percentage}%` : "-"}</strong>
          </div>
          <button type="button" onClick={() => setShowRanking((current) => !current)}>
            {showRanking ? "Tutup peringkat kelas" : "Lihat peringkat absensi sholat per kelas"}
          </button>
        </div>
      </div>
      <section className="dashboard-insight report-insight">
        <div
          className="attendance-pie"
          style={{
            background: `conic-gradient(var(--green) 0 ${reportSholatPercentage}%, #efb0aa ${reportSholatPercentage}% ${reportSholatPercentage + reportHaidPercentage}%, #f2d77c ${reportSholatPercentage + reportHaidPercentage}% 100%)`,
          }}
        >
          <div>
            <strong>{reportSholatPercentage}%</strong>
            <span>sholat</span>
          </div>
        </div>
        <div className="attendance-legend">
          <p className="eyebrow">PERSENTASE PERIODE</p>
          <h2>Progress absensi</h2>
          <span><i className="legend-dot legend-present" /> Sholat <b>{reportSholatPercentage}%</b></span>
          <span><i className="legend-dot legend-haid" /> Haid <b>{reportHaidPercentage}%</b></span>
          <span><i className="legend-dot legend-pending" /> Belum absen <b>{reportPendingPercentage}%</b></span>
       </div>
      </section>
      <label className="report-search">
        <MagnifyingGlass size={19} />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Cari nama murid..."
        />
      </label>
      {showRanking && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowRanking(false)}>
          <section
            className="student-modal ranking-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ranking-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ranking-modal-head">
              <div>
                <p className="eyebrow">PERINGKAT KELAS</p>
                <h2 id="ranking-title">Absensi sholat per kelas</h2>
                <p className="muted">Periode {monthlyLabel}. Diurutkan dari persentase sholat tertinggi.</p>
              </div>
              <button type="button" onClick={() => setShowRanking(false)} aria-label="Tutup peringkat">
                <X size={22} />
              </button>
            </div>
            <div className="ranking-list ranking-list-modal">
              {rankedClasses.length ? (
                rankedClasses.map((item, index) => (
                  <div key={item.className}>
                    <span className="person-initial attendance-number">{index + 1}</span>
                    <div>
                      <strong>Kelas {item.className}</strong>
                      <span>{item.studentCount} murid · {item.sholatCount} sholat · {item.absentCount} tidak sholat · {item.haidCount} haid</span>
                    </div>
                    <b>{item.percentage}%</b>
                  </div>
                ))
              ) : (
                <div className="empty">Belum ada data peringkat untuk filter ini.</div>
              )}
            </div>
          </section>
        </div>
      )}
      <div className="report-list">
        {searchedRecords.length ? (
          recordPage.items.map((item, index) => (
            <div key={item.id}>
              <span className="person-initial attendance-number">{recordPage.offset + index + 1}</span>
                <div>
                  <strong>{item.studentName}</strong>
                   <span>
                     Kelas {item.className} ·{" "}
                      <b className={item.pending ? "status-badge status-pending" : item.status === "Haid" ? "status-badge status-haid" : item.status === "Terlambat" ? "status-badge status-late" : "status-badge status-hadir"}>
                       {item.status || "Hadir"}
                     </b>
                   </span>
                </div>
              <time>
                {new Intl.DateTimeFormat("id-ID", {
                  day: "numeric",
                  month: "short",
                }).format(new Date(item.date + "T12:00:00"))}
                {!item.pending && <b>{item.time}</b>}
              </time>
            </div>
          ))
        ) : (
          <div className="empty">
            <CalendarBlank size={28} />
            <span>Tidak ada murid pada status yang dipilih.</span>
          </div>
        )}
      </div>
      <Pagination pagination={recordPage} />
    </section>
  );
}

function AttendanceCheckPage({ students, history, holidays, todayKey, selectedDate, loading, onDateChange, onMarkStudentForDate, onCancelAttendance }) {
  const [selectedClass, setSelectedClass] = useState("Semua kelas");
  const [searchQuery, setSearchQuery] = useState("");
  const requestDate = useEffectEvent(onDateChange);
  useEffect(() => {
    requestDate(selectedDate);
  }, []);
  const classOptions = [...new Set(students.map((student) => student.className).filter(Boolean))].sort();
  const matchesSearch = (value) => value.toLowerCase().includes(searchQuery.toLowerCase());
  const selectedStudents = students.filter(
    (student) =>
      (selectedClass === "Semua kelas" || student.className === selectedClass) &&
      matchesSearch(`${student.name} ${student.className}`),
  );
  const selectedAttendances = history
    .filter(
      (item) =>
        item.date === selectedDate &&
        (selectedClass === "Semua kelas" || item.className === selectedClass) &&
        matchesSearch(`${item.studentName} ${item.className} ${item.status || "Hadir"}`),
    )
    .sort((first, second) => first.studentName.localeCompare(second.studentName, "id"));
  const unconfirmedStudents = selectedStudents.filter(
    (student) => !selectedAttendances.some((item) => item.studentId === student.id),
  );
  const isHoliday = holidays.includes(selectedDate);
  const isFutureDate = selectedDate > todayKey;
  const filterKey = `${selectedDate}|${selectedClass}|${searchQuery}`;
  const unconfirmedPage = usePagination(unconfirmedStudents, filterKey);
  const confirmedPage = usePagination(selectedAttendances, filterKey);
  if (loading) {
    return (
      <section className="attendance-check-page empty">
        <DatabaseLoading label="Memuat data absensi..." />
      </section>
    );
  }
  return (
    <section className="attendance-check-page">
      <div className="attendance-check-controls">
        <label className="dashboard-search">
          <MagnifyingGlass size={19} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Cari nama murid..."
          />
        </label>
        <label>
          Tanggal Absen
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </label>
        <label>
          Kelas
          <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>
            <option>Semua kelas</option>
            {classOptions.map((className) => <option key={className}>{className}</option>)}
          </select>
        </label>
      </div>
      {isHoliday && <p className="report-holiday-note">Tanggal ini ditetapkan sebagai hari libur.</p>}
      {isFutureDate && <p className="attendance-check-note">Absensi untuk tanggal mendatang belum tersedia.</p>}
      <section className="unconfirmed-panel">
        <div className="panel-title">
          <div>
            <h2>Murid Belum Absen</h2>
            <p>Tandai status absensi untuk tanggal yang dipilih.</p>
          </div>
          <span>{unconfirmedStudents.length} murid</span>
        </div>
        {unconfirmedStudents.length ? (
          <>
          <div className="unconfirmed-list">
            {unconfirmedPage.items.map((student, index) => (
              <div key={student.id}>
                <span className="person-initial attendance-number">{unconfirmedPage.offset + index + 1}</span>
                <div>
                  <strong>{student.name}</strong>
                  <span>Kelas {student.className}</span>
                </div>
                <div className="unconfirmed-actions">
                  <button
                    className="mark-present-button"
                    disabled={isHoliday || isFutureDate}
                    onClick={() => onMarkStudentForDate(student, "Hadir", selectedDate)}
                  >
                    Tandai Hadir
                  </button>
                  {student.gender === "Perempuan" && (
                    <button
                      className="mark-present-button mark-haid-button"
                      disabled={isHoliday || isFutureDate}
                      onClick={() => onMarkStudentForDate(student, "Haid", selectedDate)}
                    >
                      Tandai Haid
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Pagination pagination={unconfirmedPage} />
          </>
        ) : <div className="empty">Semua murid sudah absen atau tidak ditemukan.</div>}
      </section>
      <section className="attendance-panel">
        <div className="panel-title">
          <div>
            <h2>Sudah Absen</h2>
            <p>Status absensi pada tanggal yang dipilih.</p>
          </div>
          <span>{selectedAttendances.length} konfirmasi</span>
        </div>
        {selectedAttendances.length ? (
          <>
          <div className="attendance-list">
            {confirmedPage.items.map((item, index) => (
              <div key={item.id}>
                <span className="person-initial attendance-number">{confirmedPage.offset + index + 1}</span>
                <div className="attendance-person">
                  <strong>{item.studentName}</strong>
                  <span className="attendance-class">Kelas {item.className}</span>
                </div>
                <div className="attendance-meta">
                  <b className={item.status === "Haid" ? "status-badge status-haid" : item.status === "Terlambat" ? "status-badge status-late" : "status-badge status-hadir"}>
                    {item.status || "Hadir"}
                  </b>
                  <time>{item.time}</time>
                  <button
                    className="cancel-attendance"
                    aria-label={`Batalkan status ${item.studentName}`}
                    onClick={() => onCancelAttendance(item)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Pagination pagination={confirmedPage} />
          </>
        ) : <div className="empty">Belum ada murid yang absen pada tanggal ini.</div>}
      </section>
    </section>
  );
}
function Metric({ label, value, detail, tone, active, onClick }) {
  const content = (
    <>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        className={`metric ${tone} metric-button${active ? " metric-active" : ""}`}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }
  return (
    <article className={`metric ${tone}`}>
      {content}
    </article>
  );
}
function Students({
  students,
  allStudents,
  classOptions,
  query,
  setQuery,
  classFilter,
  setClassFilter,
  setEditing,
  onDelete,
  onResetPassword,
}) {
  const [preview, setPreview] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const studentPage = usePagination(students, `${query}|${classFilter}`);
  function handleFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      try {
        const XLSX = await import("xlsx-js-style");
        const workbook = XLSX.read(loadEvent.target.result, { type: "array" });
        const rows = XLSX.utils.sheet_to_json(
          workbook.Sheets[workbook.SheetNames[0]],
          { header: 1, defval: "" },
        );
        const imported = parseImportedRows(rows, allStudents);
        const noNewStudentsMessage = [
          imported.duplicates.length
            ? `${imported.duplicates.length} data duplikat berdasarkan NIS`
            : "",
          imported.excludedNonIslam.length
            ? `${imported.excludedNonIslam.length} data bukan agama IS`
            : "",
        ]
          .filter(Boolean)
          .join(" dan ");
        setPreview({
          fileName: file.name,
          students: imported.students,
          excludedNonIslam: imported.excludedNonIslam,
          duplicates: imported.duplicates,
          noNewStudents: !imported.students.length && Boolean(noNewStudentsMessage),
          error: imported.students.length
            ? ""
            : noNewStudentsMessage
              ? `Tidak ada data baru yang bisa ditambahkan: ${noNewStudentsMessage}.`
              : "Tidak ada data murid yang bisa dibaca.",
        });
      } catch (error) {
        setPreview({
          fileName: file.name,
          students: [],
          excludedNonIslam: [],
          duplicates: [],
          noNewStudents: false,
          error: error.message,
        });
      }
    };
    reader.readAsArrayBuffer(file);
  }
  async function confirmImport() {
    if (!preview?.students?.length || preview.importing) return;
    const rows = preview.students.map((item) => ({
      nis: item.nis,
      name: item.name,
      className: item.className,
      gender: item.gender,
      username: item.username,
      password: DEFAULT_STUDENT_PASSWORD,
    }));
    const total = rows.length;
    const results = [];
    let requestError = "";
    for (let start = 0; start < total; start += IMPORT_BATCH_SIZE) {
      const batch = rows.slice(start, start + IMPORT_BATCH_SIZE);
      const progress = `Mengimpor ${start + batch.length} dari ${total} murid...`;
      setPreview((current) => ({ ...current, importing: true, progress }));
      const { data, error } = await importStudents(batch);
      if (error) {
        requestError = error;
        break;
      }
      results.push(...data.results);
    }
    const failures = results.filter((item) => item.status === "error");
    if (!requestError && !failures.length) {
      window.location.reload();
      return;
    }
    const created = results.filter((item) => item.status === "created").length;
    const duplicates = results.filter((item) => item.status === "duplicate").length;
    const summary = [
      `${created} murid tersimpan`,
      duplicates ? `${duplicates} username sudah digunakan` : "",
      failures.length ? `${failures.length} gagal` : "",
      requestError ? `${total - results.length} belum diproses` : "",
    ]
      .filter(Boolean)
      .join(", ");
    setPreview((current) => ({
      ...current,
      importing: false,
      progress: "",
      failures,
      error: requestError
        ? `Import berhenti: ${requestError} (${summary}).`
        : `Sebagian murid gagal diimpor (${summary}).`,
    }));
  }
  return (
    <section className="students-panel">
      <div className="table-actions">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari nama atau username"
        />
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
        >
          <option>Semua kelas</option>
          {classOptions.map((className) => (
            <option key={className}>{className}</option>
          ))}
        </select>
        <label className="file-button secondary">
          <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} />
          Import Excel/CSV
        </label>
        <button
          className="primary compact"
          onClick={() =>
            setEditing({
              name: "",
              className: classOptions[0] || "",
              username: "",
            })
          }
        >
          <Plus size={18} />
          Tambah murid
        </button>
      </div>
      <div className="data-table">
        <div className="table-head">
          <span>Nama lengkap</span>
          <span>Kelas</span>
          <span>Gender</span>
          <span>Username</span>
          <span>Password</span>
          <span>Aksi</span>
        </div>
        {studentPage.items.map((student, index) => (
          <div className="table-row" key={student.id}>
            <strong>
              <span className="student-number">{studentPage.offset + index + 1}</span>
              {student.name}
            </strong>
            <span>
              <b className="class-chip">{student.className}</b>
            </span>
            <span>
              {student.gender === "Perempuan"
                ? "P"
                : student.gender === "Laki-laki"
                  ? "L"
                  : "-"}
            </span>
            <span>{student.username}</span>
            <span>
              <button
                type="button"
                className="secondary reset-password-button"
                onClick={() => setResetTarget(student)}
              >
                Reset password
              </button>
            </span>
            <span className="row-actions">
              <button
                aria-label="Edit murid"
                onClick={() => setEditing(student)}
              >
                <PencilSimple size={18} />
              </button>
              <button
                aria-label="Nonaktifkan murid"
                title="Nonaktifkan murid"
                onClick={() => onDelete(student.id)}
              >
                <Trash size={18} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <Pagination pagination={studentPage} />
      {preview && (
        <ImportPreview
          preview={preview}
          onClose={() => setPreview(null)}
          onConfirm={confirmImport}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal
          student={resetTarget}
          onClose={() => setResetTarget(null)}
          onReset={onResetPassword}
        />
      )}
    </section>
  );
}

function ImportPreview({ preview, onClose, onConfirm }) {
  const groupedStudents = Object.entries(
    preview.students.reduce((groups, student) => {
      const className = student.className || "Kelas belum diatur";
      if (!groups[className]) groups[className] = [];
      groups[className].push(student);
      return groups;
    }, {}),
  ).sort(([first], [second]) => first.localeCompare(second, "id", { numeric: true }));
  return (
    <div className="modal-backdrop">
      <section className="student-modal import-modal">
        <div>
          <p className="eyebrow">KONFIRMASI IMPORT</p>
          <h2>
            {preview.noNewStudents
              ? "Data sudah tersimpan"
              : preview.failures
                ? "Import belum selesai"
                : preview.error
                  ? "File belum bisa diimpor"
                  : "Periksa data murid"}
          </h2>
          <p className="muted">{preview.fileName}</p>
        </div>
        {preview.error ? (
          <>
            <p className={preview.noNewStudents ? "import-info" : "form-error"}>
              {preview.error}
            </p>
            {preview.failures?.length > 0 && (
              <ul className="import-warning import-failures">
                {preview.failures.map((failure, index) => (
                  <li key={`${failure.username}-${index}`}>
                    <strong>{failure.username || "(username kosong)"}</strong>: {failure.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="import-summary">
              {preview.students.length} murid siap ditambahkan. Pastikan data
               sudah benar sebelum menyimpan.
            </p>
            {preview.excludedNonIslam?.length > 0 && (
              <p className="import-warning">
                {preview.excludedNonIslam.length} murid dikecualikan karena agama
                bukan IS atau kolom AGM kosong.
              </p>
            )}
            {preview.duplicates?.length > 0 && (
              <p className="import-warning">
                {preview.duplicates.length} data duplikat berdasarkan NIS
                dikecualikan.
              </p>
            )}
            <div className="import-class-summary">
              {groupedStudents.map(([className, classStudents]) => (
                <span key={className}>
                  <strong>{className}</strong> {classStudents.length} siswa
                </span>
              ))}
            </div>
            {preview.progress && (
              <p className="import-info" role="status">
                {preview.progress}
              </p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={preview.importing}
          >
            {preview.failures ? "Tutup" : "Batal"}
          </button>
          {!preview.error && (
            <button
              type="button"
              className="primary"
              onClick={onConfirm}
              disabled={preview.importing}
            >
              {preview.importing ? "Mengimpor..." : "Data sudah benar, simpan"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
function QrPage() {
  const url =
    typeof window === "undefined"
      ? "https://domain-sekolah.id/dzuhur"
      : new URL("/dzuhur", window.location.origin).toString();
  const qrRef = useRef(null);
  function downloadQr() {
    const canvas = qrRef.current?.querySelector("canvas");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = "qr-absensi-dzuhur.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }
  return (
    <section className="qr-panel">
      <div>
        <p className="eyebrow">SATU QR PERMANEN</p>
        <h2>Tempelkan QR ini di area sholat.</h2>
        <p>Setelah murid login, QR membuka halaman konfirmasi sholat Dzuhur.</p>
        <code>{url}</code>
        <a className="primary qr-link" href={url}>
          Buka halaman Dzuhur
        </a>
      </div>
      <div className="qr-area">
        <div ref={qrRef} className="qr-print">
          <QRCodeCanvas
            value={url}
            size={280}
            bgColor="#ffffff"
            fgColor="#123d2a"
            includeMargin
          />
        </div>
        <button className="secondary qr-download" onClick={downloadQr}>
          <DownloadSimple size={19} />
          Download QR
        </button>
      </div>
    </section>
  );
}
function SettingsPage({ onLogout, onChangePassword, prayerSchedule, scheduleReady, onSavePrayerSchedule, serverNow }) {
  const [draftSchedule, setDraftSchedule] = useState(prayerSchedule);
  const [scheduleNotice, setScheduleNotice] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);

  useEffect(() => {
    setDraftSchedule(prayerSchedule);
  }, [prayerSchedule]);

  async function saveSchedule(event) {
    event.preventDefault();
    if (timeToMinutes(draftSchedule.start) >= timeToMinutes(draftSchedule.end)) {
      setScheduleNotice("Jam selesai harus lebih akhir dari jam mulai.");
      return;
    }
    if (!draftSchedule.attendanceStartDate) {
      setScheduleNotice("Tanggal mulai absensi wajib diisi.");
      return;
    }
    setSavingSchedule(true);
    try {
      const error = await onSavePrayerSchedule(draftSchedule);
      setScheduleNotice(error || "Jadwal konfirmasi berhasil disimpan.");
    } finally {
      setSavingSchedule(false);
    }
  }

  return (
      <section className="simple-panel">
        <ClipboardText size={28} />
        <h2>Pengaturan aplikasi</h2>
        <div className="server-clock">
          <span>Waktu server (WIB)</span>
          <strong>{new Intl.DateTimeFormat("id-ID", {
            dateStyle: "full",
            timeStyle: "medium",
            timeZone: "Asia/Jakarta",
          }).format(serverNow)}</strong>
        </div>
      <form className="prayer-schedule-settings" onSubmit={saveSchedule}>
        <div>
          <strong>Jadwal konfirmasi Dzuhur</strong>
          <span>Atur kapan murid boleh mengirim konfirmasi sholat atau haid.</span>
        </div>
        <label className="schedule-switch">
          <input
            type="checkbox"
            checked={draftSchedule.enabled}
            onChange={(event) =>
              setDraftSchedule((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
          <span>Aktifkan batas waktu</span>
        </label>
        <div className="schedule-times">
          <label>
            Mulai
            <input
              type="time"
              value={draftSchedule.start}
              disabled={!draftSchedule.enabled}
              onChange={(event) =>
                setDraftSchedule((current) => ({ ...current, start: event.target.value }))
              }
            />
          </label>
          <label>
            Selesai
            <input
              type="time"
              value={draftSchedule.end}
              disabled={!draftSchedule.enabled}
              onChange={(event) =>
                setDraftSchedule((current) => ({ ...current, end: event.target.value }))
              }
            />
          </label>
        </div>
        <div className="schedule-times">
          <label>
            Tanggal mulai absensi
            <input
              type="date"
              value={draftSchedule.attendanceStartDate || ""}
              required
              onChange={(event) =>
                setDraftSchedule((current) => ({
                  ...current,
                  attendanceStartDate: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <span className="muted">
          Murid hanya dapat memperbaiki absensi mulai tanggal ini.
        </span>
        {scheduleNotice && <p className="schedule-notice">{scheduleNotice}</p>}
        <button className="primary" type="submit" disabled={!scheduleReady || savingSchedule}>
          {savingSchedule ? "Menyimpan..." : "Simpan jadwal"}
        </button>
      </form>
      <div className="settings-signout">
        <div>
          <strong>Ganti password</strong>
          <span>Perbarui password akun guru secara berkala.</span>
        </div>
        <button className="secondary" onClick={onChangePassword}>
          Ganti password
        </button>
      </div>
      <div className="settings-signout">
        <div>
          <strong>Keluar dari akun</strong>
          <span>Anda perlu login kembali untuk mengakses dashboard.</span>
        </div>
        <button className="danger-button" onClick={onLogout}>
          <span className="logout-content">
            <SignOut size={19} />
            <span>Keluar</span>
          </span>
        </button>
      </div>
    </section>
  );
}

function PasswordInput(props) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="password-field">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        aria-label={visible ? "Sembunyikan password" : "Tampilkan password"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeSlash size={20} /> : <Eye size={20} />}
      </button>
    </span>
  );
}

function PasswordModal({ role, onClose, onChangePassword }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    const confirmation = String(form.get("confirmation") || "");
    if (newPassword.length < 3) {
      setError("Password baru minimal 3 karakter.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("Konfirmasi password belum sesuai.");
      return;
    }
    setSaving(true);
    const message = await onChangePassword({ currentPassword, newPassword });
    setSaving(false);
    if (!message.includes("berhasil")) {
      setError(message);
      return;
    }
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <form className="student-modal" onSubmit={submit}>
        <div>
          <p className="eyebrow">KEAMANAN AKUN</p>
          <h2>Ganti password {role === "admin" ? "guru" : "murid"}</h2>
          <p className="muted">Masukkan password saat ini dan password baru.</p>
        </div>
        <label>
          Password saat ini
          <PasswordInput name="currentPassword" required autoComplete="current-password" />
        </label>
        <label>
          Password baru
          <PasswordInput name="newPassword" required autoComplete="new-password" />
        </label>
        <label>
          Konfirmasi password baru
          <PasswordInput name="confirmation" required autoComplete="new-password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Batal
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Menyimpan..." : "Simpan password"}
          </button>
        </div>
      </form>
    </div>
  );
}

function StudentModal({ student, classOptions, onClose, onSave }) {
  return (
    <div className="modal-backdrop">
      <form className="student-modal" onSubmit={onSave}>
        <div>
          <p className="eyebrow">
            {student.id ? "EDIT MURID" : "TAMBAH MURID"}
          </p>
          <h2>
            {student.id ? "Perbarui data murid" : "Masukkan data murid baru"}
          </h2>
        </div>
        <label>
          NIS
          <input name="nis" defaultValue={student.nis} />
        </label>
        <label>
          Nama lengkap
          <input name="name" defaultValue={student.name} required />
        </label>
        <label>
          Kelas
          <select name="className" defaultValue={student.className}>
            {classOptions.map((className) => (
              <option key={className}>{className}</option>
            ))}
          </select>
        </label>
        <label>
          Jenis kelamin
          <select name="gender" defaultValue={student.gender}>
            <option value="">Belum diatur</option>
            <option value="Laki-laki">Laki-laki</option>
            <option value="Perempuan">Perempuan</option>
          </select>
        </label>
        <label>
          Username
          <input name="username" defaultValue={student.username} required />
        </label>
        {!student.id && (
          <label>
            Password
            <input name="password" defaultValue={DEFAULT_STUDENT_PASSWORD} required />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Batal
          </button>
          <button type="submit" className="primary">
            Simpan data
          </button>
        </div>
      </form>
    </div>
  );
}

function ResetPasswordModal({ student, onClose, onReset }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") || "");
    const confirmation = String(form.get("confirmation") || "");
    if (newPassword.length < 3) {
      setError("Password baru minimal 3 karakter.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("Konfirmasi password belum sesuai.");
      return;
    }
    setSaving(true);
    const message = await onReset(student, newPassword);
    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <form className="student-modal" onSubmit={submit}>
        <div>
          <p className="eyebrow">RESET PASSWORD</p>
          <h2>Reset password murid</h2>
          <p className="muted">
            Atur password baru untuk <strong>{student.name}</strong> ({student.username}).
          </p>
        </div>
        <label>
          Password baru
          <PasswordInput name="newPassword" required autoComplete="new-password" />
        </label>
        <label>
          Konfirmasi password baru
          <PasswordInput name="confirmation" required autoComplete="new-password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Batal
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Menyimpan..." : "Simpan password"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteConfirm({ student, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="student-modal delete-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-student-title"
      >
        <div className="delete-icon">
          <WarningCircle size={30} weight="fill" />
        </div>
        <div>
          <p className="eyebrow">KONFIRMASI NONAKTIFKAN</p>
          <h2 id="delete-student-title">Nonaktifkan murid?</h2>
          <p className="muted">
            <strong>{student.name}</strong> akan disembunyikan dari daftar murid dan
            tidak bisa login lagi. Riwayat absensinya tetap tersimpan.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Batal
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Nonaktifkan murid
          </button>
        </div>
      </section>
    </div>
  );
}

function CancelAttendanceConfirm({ attendance, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="student-modal delete-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cancel-attendance-title"
      >
        <div className="delete-icon">
          <WarningCircle size={30} weight="fill" />
        </div>
        <div>
          <p className="eyebrow">KONFIRMASI PEMBATALAN</p>
          <h2 id="cancel-attendance-title">Batalkan status absensi?</h2>
          <p className="muted">
            Status {attendance.status || "Hadir"} untuk <strong>{attendance.studentName}</strong> akan
            dibatalkan dan dapat dikonfirmasi kembali.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Jangan batalkan
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Batalkan status
          </button>
        </div>
      </section>
    </div>
  );
}
