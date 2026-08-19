"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import {
  BookOpen,
  CalendarBlank,
  CaretDown,
  CheckCircle,
  ClipboardText,
  DownloadSimple,
  Gear,
  House,
  List,
  PencilSimple,
  X,
  Plus,
  QrCode,
  SignOut,
  Trash,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";

const initialStudents = [
  ["Irfan Maulana", "9A", "9A_Irfan"],
  ["Ahmad Fauzi", "9A", "9A_Ahmad"],
  ["Bima Pratama", "9A", "9A_Bima"],
  ["Dimas Saputra", "9A", "9A_Dimas"],
  ["Fajar Ramadhan", "9A", "9A_Fajar"],
  ["Rizky Kurniawan", "9A", "9A_Rizky"],
  ["Ardiansyah Putra", "9A", "9A_Ardi"],
  ["Ilham Nugraha", "9A", "9A_Ilham"],
  ["Rafi Akbar", "9A", "9A_Rafi"],
  ["Yusuf Hidayat", "9A", "9A_Yusuf"],
  ["Andi Prasetyo", "9B", "9B_Andi"],
  ["Bagus Setiawan", "9B", "9B_Bagus"],
  ["Cahyo Prabowo", "9B", "9B_Cahyo"],
  ["Deni Kurnia", "9B", "9B_Deni"],
  ["Eko Saputro", "9B", "9B_Eko"],
  ["Galih Prakoso", "9B", "9B_Galih"],
  ["Hendra Wijaya", "9B", "9B_Hendra"],
  ["Joko Santoso", "9B", "9B_Joko"],
  ["Lukman Hakim", "9B", "9B_Lukman"],
  ["Nanda Pratama", "9B", "9B_Nanda"],
  ["Alya Nurfadilah", "9C", "9C_Alya"],
  ["Aisyah Rahmawati", "9C", "9C_Aisyah"],
  ["Citra Lestari", "9C", "9C_Citra"],
  ["Dinda Ayu Permata", "9C", "9C_Dinda"],
  ["Fitri Handayani", "9C", "9C_Fitri"],
  ["Ghina Azzahra", "9C", "9C_Ghina"],
  ["Hana Safitri", "9C", "9C_Hana"],
  ["Intan Sari", "9C", "9C_Intan"],
  ["Karina Putri", "9C", "9C_Karina"],
  ["Nabila Zahra", "9C", "9C_Nabila"],
  ["Aditya Pratama", "9D", "9D_Aditya"],
  ["Bayu Firmansyah", "9D", "9D_Bayu"],
  ["Daffa Alfarizi", "9D", "9D_Daffa"],
  ["Fikri Ramadhan", "9D", "9D_Fikri"],
  ["Hafiz Maulana", "9D", "9D_Hafiz"],
  ["Kevin Pratama", "9D", "9D_Kevin"],
  ["Muhammad Farhan", "9D", "9D_Muhammad"],
  ["Rangga Saputra", "9D", "9D_Rangga"],
  ["Satria Wibowo", "9D", "9D_Satria"],
  ["Zidan Alamsyah", "9D", "9D_Zidan"],
].map(([name, className, username], index) => ({
  id: index + 1,
  name,
  className,
  username,
  password: "123",
}));

function createId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString() + "-" + Math.random().toString(16).slice(2);
}

function normalizeImportHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s./_-]/g, "");
}

function normalizeStudentName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^(')?([a-z])/, (_, apostrophe = "", letter) => `${apostrophe}${letter.toUpperCase()}`)
    .replace(/(^|[\s-])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`)
    .trim();
}

async function fetchAllSupabaseRows(table, columns = "*") {
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
      return {
        id: createId(),
        nis,
        name,
        gender,
        className,
        username,
        password: "123",
      };
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

export default function Home() {
  const [students, setStudents] = useState(supabase ? [] : initialStudents);
  const [attendances, setAttendances] = useState([]);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("dashboard");
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("Semua kelas");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [attendanceNotice, setAttendanceNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [menstruationDecision, setMenstruationDecision] = useState(null);
  const [teacherPassword, setTeacherPassword] = useState("123");
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  const todayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(new Date());

  useEffect(() => {
    let active = true;
    async function loadData() {
      if (supabase) {
        const [studentsResult, attendancesResult] = await Promise.all([
          fetchAllSupabaseRows("students"),
          fetchAllSupabaseRows("attendances"),
        ]);
        const remoteStudents = studentsResult.data;
        const remoteAttendances = attendancesResult.data;
        const studentsError = studentsResult.error;
        const attendancesError = attendancesResult.error;
        if (studentsError || attendancesError)
          setNotice(
            "Database belum siap. Jalankan schema Supabase terlebih dahulu.",
          );
        if (remoteStudents?.length) {
          const remote = remoteStudents.map((item) => ({
            id: item.id,
            nis: item.nis || "",
            name: normalizeStudentName(item.name),
            className: item.class_name,
            gender: item.gender || "",
            username: item.username,
            password: item.password,
          }));
          setStudents(remote);
        } else if (supabase) {
          setStudents([]);
        } else {
          const localStudents = JSON.parse(
            localStorage.getItem("dzuhur-students") || "[]",
          );
          if (localStudents.length) setStudents(localStudents);
        }
        if (remoteAttendances)
          setAttendances(
            remoteAttendances.map((item) => ({
              id: item.id,
              studentId: item.student_id,
              studentName: item.student_name,
              className: item.class_name,
              date: item.date,
              time: item.time,
              status: item.status,
            })),
          );
      } else {
        const storedStudents = localStorage.getItem("dzuhur-students");
        const storedAttendances = localStorage.getItem("dzuhur-attendances");
        if (storedStudents) setStudents(JSON.parse(storedStudents));
        if (storedAttendances) setAttendances(JSON.parse(storedAttendances));
      }
      const storedSession = localStorage.getItem("dzuhur-session");
      if (storedSession) setUser(JSON.parse(storedSession));
      const storedTeacherPassword = localStorage.getItem("dzuhur-teacher-password");
      if (storedTeacherPassword) setTeacherPassword(storedTeacherPassword);
      if (active) setReady(true);
    }
    loadData();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (!supabase) localStorage.setItem("dzuhur-students", JSON.stringify(students));
  }, [students, ready]);
  useEffect(() => {
    if (!ready) return;
    if (!supabase)
      localStorage.setItem("dzuhur-attendances", JSON.stringify(attendances));
  }, [attendances, ready]);
  useEffect(() => {
    if (!supabase) return;
    async function refreshRemoteData() {
      const [studentsResult, attendancesResult] = await Promise.all([
        fetchAllSupabaseRows("students"),
        fetchAllSupabaseRows("attendances"),
      ]);
      if (studentsResult.data) {
        setStudents(
          studentsResult.data.map((item) => ({
            id: item.id,
            nis: item.nis || "",
            name: normalizeStudentName(item.name),
            className: item.class_name,
            gender: item.gender || "",
            username: item.username,
            password: item.password,
          })),
        );
      }
      if (attendancesResult.data) {
        setAttendances(
          attendancesResult.data.map((item) => ({
            id: item.id,
            studentId: item.student_id,
            studentName: item.student_name,
            className: item.class_name,
            date: item.date,
            time: item.time,
            status: item.status,
          })),
        );
      }
    }
    const channel = supabase
      .channel("absensi-sholat-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "students" }, refreshRemoteData)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendances" }, refreshRemoteData)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
  useEffect(() => {
    if (!user || user.role !== "student") setMenstruationDecision(null);
  }, [user]);

  const todayAttendance = attendances.filter((item) => item.date === todayKey);
  const filteredStudents = useMemo(
    () =>
      students
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
    [students, classFilter, query],
  );

  function login(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = form.get("username").trim();
    const password = form.get("password");
    if (username === "guru" && password === teacherPassword) {
      const session = { name: "Guru Admin", role: "admin" };
      setUser(session);
      localStorage.setItem("dzuhur-session", JSON.stringify(session));
      setView("dashboard");
      return;
    }
    const student = students.find(
      (item) => item.username === username && item.password === password,
    );
    if (student) {
      const session = { ...student, role: "student" };
      setUser(session);
      localStorage.setItem("dzuhur-session", JSON.stringify(session));
      return;
    }
    setNotice("Username atau password belum sesuai.");
  }

  async function changePassword({ currentPassword, newPassword }) {
    if (user.role === "admin") {
      if (currentPassword !== teacherPassword) return "Password saat ini tidak sesuai.";
      localStorage.setItem("dzuhur-teacher-password", newPassword);
      setTeacherPassword(newPassword);
      return "Password guru berhasil diubah.";
    }
    if (currentPassword !== user.password) return "Password saat ini tidak sesuai.";
    if (supabase) {
      const { error } = await supabase
        .from("students")
        .update({ password: newPassword })
        .eq("id", String(user.id));
      if (error) return `Gagal mengubah password: ${error.message}`;
    }
    const updatedUser = { ...user, password: newPassword };
    setStudents((current) =>
      current.map((student) => (student.id === user.id ? updatedUser : student)),
    );
    setUser(updatedUser);
    localStorage.setItem("dzuhur-session", JSON.stringify(updatedUser));
    return "Password murid berhasil diubah.";
  }

  async function recordAttendance(status) {
    if (
      attendances.some(
        (item) => item.studentId === user.id && item.date === todayKey,
      )
    )
      return;
    const record = {
      id: createId(),
      studentId: user.id,
      studentName: user.name,
      className: user.className,
      date: todayKey,
      time: new Intl.DateTimeFormat("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }).format(new Date()),
      status,
    };
    if (supabase) {
      const { error } = await supabase.from("attendances").insert({
        id: String(record.id),
        student_id: String(record.studentId),
        student_name: record.studentName,
        class_name: record.className,
        date: record.date,
        time: record.time,
        status: record.status,
      });
      if (error) {
        setAttendanceNotice(`Gagal menyimpan absensi: ${error.message}`);
        return;
      }
    }
    setAttendanceNotice("");
    setAttendances((current) => [record, ...current]);
  }

  function confirmPrayer() {
    return recordAttendance("Hadir");
  }

  function recordMenstruation() {
    return recordAttendance("Haid");
  }

  async function saveStudent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const isEditing = Boolean(editing?.id);
    const value = {
      id: isEditing ? editing.id : createId(),
      nis: form.get("nis") || "",
      name: normalizeStudentName(form.get("name")),
      className: form.get("className"),
      gender: form.get("gender") || "",
      username: String(form.get("username") || "").trim(),
      password: form.get("password"),
    };
    if (
      students.some(
        (item) => item.username === value.username && item.id !== value.id,
      )
    ) {
      setNotice("Username sudah digunakan.");
      return;
    }
    if (supabase) {
      const payload = {
        nis: value.nis,
        name: value.name,
        class_name: value.className,
        gender: value.gender || null,
        username: value.username,
        password: value.password,
      };
      let result = isEditing
        ? await supabase
            .from("students")
            .update(payload)
            .eq("username", editing.username)
            .select("id")
            .maybeSingle()
        : await supabase.from("students").insert({ id: String(value.id), ...payload });
      if (isEditing && !result.error && !result.data) {
        result = await supabase
          .from("students")
          .update(payload)
          .eq("id", String(value.id))
          .select("id")
          .maybeSingle();
      }
      const { error } = result;
      if (isEditing && !error && !result.data) {
        setNotice("Data murid tidak ditemukan di database. Muat ulang data lalu coba lagi.");
        return;
      }
      if (error) {
        setNotice(`Gagal menyimpan data murid: ${error.message}`);
        return;
      }
    }
    setStudents(
      isEditing
        ? students.map((item) => (item.id === value.id ? value : item))
        : [...students, value],
    );
    setEditing(null);
  }

  function requestDelete(id) {
    setDeleteTarget(students.find((item) => item.id === id) || null);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    if (supabase) await supabase.from("students").delete().eq("id", String(id));
    setStudents(students.filter((item) => item.id !== id));
    setDeleteTarget(null);
  }

  if (!ready)
    return (
      <main className="session-loading">
        <div>
          <Logo />
          <p>Menyiapkan AbsensiSholat</p>
        </div>
      </main>
    );
  if (!user) return <Login notice={notice} onLogin={login} />;
  if (user.role === "student") {
    // Fitur spinwheel dinonaktifkan karena tidak digunakan lagi.
    return (
      <>
        <StudentPage
          user={user}
          attendances={attendances}
          todayKey={todayKey}
          onConfirm={confirmPrayer}
          onHaid={recordMenstruation}
          attendanceNotice={attendanceNotice}
          onChangePassword={() => setPasswordModalOpen(true)}
          onLogout={() => {
            localStorage.removeItem("dzuhur-session");
            setUser(null);
          }}
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
      students={students}
      attendances={todayAttendance}
      history={attendances}
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
       onOpenPasswordChange={() => setPasswordModalOpen(true)}
       onChangePassword={changePassword}
      onImport={(imported) =>
        setStudents((current) => {
          const usernames = new Set(current.map((item) => item.username));
          return [
            ...current,
            ...imported.filter((item) => !usernames.has(item.username)),
          ];
        })
      }
      onLogout={() => {
        localStorage.removeItem("dzuhur-session");
        setUser(null);
      }}
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
    </>
  );
}

function Login({ notice, onLogin }) {
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
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Masukkan password"
              required
            />
          </label>
          <button className="primary" type="submit">
            Masuk ke aplikasi
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
          role="Murid"
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

function StudentPage({ user, attendances, todayKey, onConfirm, onHaid, attendanceNotice, onLogout, onChangePassword }) {
  const [timeNotice, setTimeNotice] = useState(null);
  const recorded = attendances.find(
    (item) => item.studentId === user.id && item.date === todayKey,
  );
  function handleConfirmation() {
    const minutes = jakartaMinutesNow();
    if (minutes < 690) {
      setTimeNotice({
        title: "Konfirmasi belum dibuka",
        message: "Konfirmasi sholat Dzuhur tersedia mulai pukul 11.30 WIB.",
      });
      return;
    }
    if (minutes > 900) {
      setTimeNotice({
        title: "Waktu konfirmasi sudah terlewat",
        message: "Harap konfirmasi ke guru bila terjadi kesalahan.",
      });
      return;
    }
    onConfirm();
  }
  return (
    <main className="student-shell">
      <header>
        <Logo />
        <UserMenu
          name={user.name}
          role="Murid"
          onChangePassword={onChangePassword}
          onLogout={onLogout}
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
                <button className="haid-button large" onClick={onHaid}>
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
      {attendanceNotice && <p className="student-error">{attendanceNotice}</p>}
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
              <p className="eyebrow">KONFIRMASI DZUHUR</p>
              <h2 id="time-notice-title">{timeNotice.title}</h2>
            </div>
            <p>{timeNotice.message}</p>
            <button className="primary" onClick={() => setTimeNotice(null)}>
              Mengerti
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function AdminApp(props) {
  const {
    students,
    attendances,
    history,
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
    onOpenPasswordChange,
    onChangePassword,
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
            Rekap
          </NavButton>
          <NavButton
            active={view === "students"}
            onClick={() => selectView("students")}
            icon={<UsersThree size={20} />}
          >
            Data murid
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
                ? "Ringkasan hari ini"
                : view === "reports"
                  ? "Rekap absensi"
                  : view === "students"
                    ? "Data murid"
                    : view === "qr"
                      ? "QR sholat Dzuhur"
                      : "Pengaturan"}
            </h1>
          </div>
          <UserMenu
            name="Guru Admin"
            role="Guru"
            onChangePassword={onOpenPasswordChange}
            onLogout={onLogout}
          />
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
          />
        )}
        {view === "reports" && (
          <ReportPage students={students} history={history} />
        )}
        {view === "students" && (
          <Students
            students={filteredStudents}
            allStudents={students}
            classOptions={classOptions}
            query={query}
            setQuery={setQuery}
            classFilter={classFilter}
            setClassFilter={setClassFilter}
            setEditing={setEditing}
            onDelete={onDelete}
          />
        )}
        {view === "qr" && <QrPage />}
        {view === "settings" && (
          <SettingsPage
            onLogout={onLogout}
            onChangePassword={onOpenPasswordChange}
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

function UserMenu({ name, role, onChangePassword, onLogout }) {
  const [open, setOpen] = useState(false);
  const initial = name?.trim().charAt(0).toUpperCase() || "U";

  return (
    <div className="user-menu">
      <button
        className="user-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="user-avatar">{initial}</span>
        <span className="user-menu-label">
          <strong>{name}</strong>
          <small>{role}</small>
        </span>
        <CaretDown size={16} />
      </button>
      {open && (
        <div className="user-menu-dropdown" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onChangePassword();
            }}
          >
            Ganti password
          </button>
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

function Dashboard({ students, classOptions, attendances }) {
  const [selectedClass, setSelectedClass] = useState("Semua kelas");
  const visibleStudents = students.filter(
    (student) => selectedClass === "Semua kelas" || student.className === selectedClass,
  );
  const visibleAttendances = attendances.filter(
    (item) => selectedClass === "Semua kelas" || item.className === selectedClass,
  );
  const hadirCount = visibleAttendances.filter((item) => item.status !== "Haid").length;
  const haidCount = visibleAttendances.filter((item) => item.status === "Haid").length;
  const absent = visibleStudents.length - visibleAttendances.length;
  return (
    <>
      <section className="metric-grid">
        <Metric
          label="Sudah hadir"
          value={hadirCount}
          detail="Murid terkonfirmasi"
          tone="green"
        />
        <Metric
          label="Belum hadir"
          value={absent}
          detail="Perlu ditinjau"
          tone="sand"
        />
        <Metric
          label="Total murid"
          value={visibleStudents.length}
          detail="Dari 36 kelas"
          tone="plain"
        />
      </section>
      <section className="attendance-panel">
        <div className="panel-title">
          <div>
            <h2>Absensi terbaru</h2>
            <p>Konfirmasi yang masuk hari ini.</p>
          </div>
          <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>
            <option>Semua kelas</option>
            {classOptions.map((className) => <option key={className}>{className}</option>)}
          </select>
          <span>
            {hadirCount} murid hadir{haidCount ? ` · ${haidCount} haid` : ""}
          </span>
        </div>
        {visibleAttendances.length ? (
          <div className="attendance-list">
            {visibleAttendances.map((item, index) => (
              <div key={item.id}>
                <span className="person-initial attendance-number">{index + 1}</span>
                <div className="attendance-person">
                  <strong>{item.studentName}</strong>
                  <span className="attendance-class">
                    Kelas {item.className}
                  </span>
                </div>
                <div className="attendance-meta">
                  <b className={item.status === "Haid" ? "status-badge status-haid" : "status-badge status-hadir"}>
                    {item.status || "Hadir"}
                  </b>
                  <time>{item.time}</time>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <CheckCircle size={28} />
            Belum ada konfirmasi Dzuhur hari ini.
          </div>
        )}
      </section>
    </>
  );
}
function ReportPage({ students, history }) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(new Date());
  const [period, setPeriod] = useState("daily");
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedClass, setSelectedClass] = useState("Semua kelas");
  const classOptions = [...new Set(students.map((student) => student.className).filter(Boolean))].sort();
  const records = useMemo(() => {
    const reference = new Date(selectedDate + "T12:00:00");
    const day = (reference.getDay() + 6) % 7;
    const start = new Date(reference);
    start.setDate(reference.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const month = selectedDate.slice(0, 7);
    return history
      .filter((item) => {
        const inPeriod =
          period === "daily"
            ? item.date === selectedDate
            : period === "weekly"
              ? item.date >= start.toISOString().slice(0, 10) &&
                item.date <= end.toISOString().slice(0, 10)
              : item.date.startsWith(month);
        return (
          inPeriod &&
          (selectedClass === "Semua kelas" || item.className === selectedClass)
        );
      })
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }, [history, period, selectedDate, selectedClass]);
  const uniqueStudents = new Set(records.map((item) => item.studentId)).size;
  function exportReport() {
    const rows = records.map((item, index) => ({
      No: index + 1,
      Tanggal: item.date,
      Waktu: item.time,
      Nama: item.studentName,
      Kelas: item.className,
      Status: item.status || "Hadir",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Rekap Dzuhur");
    XLSX.writeFile(workbook, `rekap-dzuhur-${selectedDate}.xlsx`);
  }
  return (
    <section className="report-panel">
      <div className="report-controls">
        <div className="period-toggle">
          <button
            className={period === "daily" ? "active" : ""}
            onClick={() => setPeriod("daily")}
          >
            Harian
          </button>
          <button
            className={period === "weekly" ? "active" : ""}
            onClick={() => setPeriod("weekly")}
          >
            Mingguan
          </button>
          <button
            className={period === "monthly" ? "active" : ""}
            onClick={() => setPeriod("monthly")}
          >
            Bulanan
          </button>
        </div>
        <label>
          Tanggal acuan
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
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
          Export Excel
        </button>
      </div>
      <div className="report-summary">
        <div>
          <span>Murid tercatat</span>
          <strong>{uniqueStudents}</strong>
        </div>
        <div>
          <span>Total konfirmasi</span>
          <strong>{records.length}</strong>
        </div>
        <p>
          {period === "daily"
            ? "Daftar murid yang sudah sholat pada tanggal terpilih."
            : period === "weekly"
              ? "Daftar konfirmasi sholat selama minggu dari tanggal terpilih."
              : "Daftar konfirmasi sholat selama bulan dari tanggal terpilih."}
        </p>
      </div>
      <div className="report-list">
        {records.length ? (
          records.map((item) => (
            <div key={item.id}>
              <span className="person-initial">{item.studentName[0]}</span>
                <div>
                  <strong>{item.studentName}</strong>
                  <span>Kelas {item.className} · {item.status || "Hadir"}</span>
                </div>
              <time>
                {new Intl.DateTimeFormat("id-ID", {
                  day: "numeric",
                  month: "short",
                }).format(new Date(item.date + "T12:00:00"))}
                <b>{item.time}</b>
              </time>
            </div>
          ))
        ) : (
          <div className="empty">
            <CalendarBlank size={28} />
            Belum ada absensi pada periode ini.
          </div>
        )}
      </div>
    </section>
  );
}
function Metric({ label, value, detail, tone }) {
  return (
    <article className={`metric ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
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
}) {
  const [preview, setPreview] = useState(null);
  function handleFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      try {
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
    if (!preview?.students?.length) return;
    if (supabase) {
      const { data: existing, error: readError } = await fetchAllSupabaseRows(
        "students",
        "username",
      );
      if (readError) {
        setPreview((current) => ({ ...current, error: readError.message }));
        return;
      }
      const usernames = new Set(
        (existing || []).map((item) => String(item.username || "").trim()),
      );
      const additions = preview.students.filter((item) => {
        const username = String(item.username || "").trim();
        if (!username || usernames.has(username)) return false;
        usernames.add(username);
        return true;
      });
      const payload = additions.map((item) => ({
          id: String(item.id),
          nis: item.nis || "",
          name: normalizeStudentName(item.name),
          class_name: item.className,
          gender: item.gender || null,
          username: String(item.username || "").trim(),
          password: item.password,
        }));
      let { error } = await supabase
        .from("students")
        .insert(payload, { onConflict: "username", ignoreDuplicates: true });
      if (error?.code === "23505") {
        error = null;
        for (const student of payload) {
          const result = await supabase.from("students").insert(student);
          if (result.error && result.error.code !== "23505") {
            error = result.error;
            break;
          }
        }
      }
      if (error) {
        setPreview((current) => ({ ...current, error: error.message }));
        return;
      }
    } else {
      const current = JSON.parse(
        localStorage.getItem("dzuhur-students") || "[]",
      );
      const usernames = new Set(current.map((item) => item.username));
      localStorage.setItem(
        "dzuhur-students",
        JSON.stringify([
          ...current,
          ...preview.students.filter((item) => !usernames.has(item.username)),
        ]),
      );
    }
    window.location.reload();
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
              password: "123",
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
        {students.map((student, index) => (
          <div className="table-row" key={student.id}>
            <strong>
              <span className="student-number">{index + 1}</span>
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
            <span className="password-text">{student.password}</span>
            <span className="row-actions">
              <button
                aria-label="Edit murid"
                onClick={() => setEditing(student)}
              >
                <PencilSimple size={18} />
              </button>
              <button
                aria-label="Hapus murid"
                onClick={() => onDelete(student.id)}
              >
                <Trash size={18} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {preview && (
        <ImportPreview
          preview={preview}
          onClose={() => setPreview(null)}
          onConfirm={confirmImport}
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
              : preview.error
                ? "File belum bisa diimpor"
                : "Periksa data murid"}
          </h2>
          <p className="muted">{preview.fileName}</p>
        </div>
        {preview.error ? (
          <p className={preview.noNewStudents ? "import-info" : "form-error"}>
            {preview.error}
          </p>
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
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Batal
          </button>
          {!preview.error && (
            <button type="button" className="primary" onClick={onConfirm}>
              Data sudah benar, simpan
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
function SettingsPage({ onLogout, onChangePassword }) {
  return (
    <section className="simple-panel">
      <ClipboardText size={28} />
      <h2>Pengaturan aplikasi</h2>
      <p>
        QR permanen memakai alamat web yang sedang dibuka dan mengarah ke
        halaman Dzuhur.
      </p>
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
          <SignOut size={19} />
          Keluar
        </button>
      </div>
    </section>
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
          <input name="currentPassword" type="password" required autoComplete="current-password" />
        </label>
        <label>
          Password baru
          <input name="newPassword" type="password" required autoComplete="new-password" />
        </label>
        <label>
          Konfirmasi password baru
          <input name="confirmation" type="password" required autoComplete="new-password" />
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
        <label>
          Password
          <input name="password" defaultValue={student.password} required />
        </label>
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
          <p className="eyebrow">KONFIRMASI HAPUS</p>
          <h2 id="delete-student-title">Hapus data murid?</h2>
          <p className="muted">
            Data <strong>{student.name}</strong> akan dihapus dari daftar murid.
            Tindakan ini tidak dapat dibatalkan.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Batal
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Hapus data
          </button>
        </div>
      </section>
    </div>
  );
}
