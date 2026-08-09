"use client";

import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  BookOpen, CheckCircle, ClipboardText, Gear, House, PencilSimple,
  Plus, QrCode, SignOut, Trash, UsersThree, WarningCircle,
} from "@phosphor-icons/react";

const initialStudents = [
  ["Irfan Maulana", "9A", "9A_Irfan"], ["Ahmad Fauzi", "9A", "9A_Ahmad"], ["Bima Pratama", "9A", "9A_Bima"], ["Dimas Saputra", "9A", "9A_Dimas"], ["Fajar Ramadhan", "9A", "9A_Fajar"], ["Rizky Kurniawan", "9A", "9A_Rizky"], ["Ardiansyah Putra", "9A", "9A_Ardi"], ["Ilham Nugraha", "9A", "9A_Ilham"], ["Rafi Akbar", "9A", "9A_Rafi"], ["Yusuf Hidayat", "9A", "9A_Yusuf"],
  ["Andi Prasetyo", "9B", "9B_Andi"], ["Bagus Setiawan", "9B", "9B_Bagus"], ["Cahyo Prabowo", "9B", "9B_Cahyo"], ["Deni Kurnia", "9B", "9B_Deni"], ["Eko Saputro", "9B", "9B_Eko"], ["Galih Prakoso", "9B", "9B_Galih"], ["Hendra Wijaya", "9B", "9B_Hendra"], ["Joko Santoso", "9B", "9B_Joko"], ["Lukman Hakim", "9B", "9B_Lukman"], ["Nanda Pratama", "9B", "9B_Nanda"],
  ["Alya Nurfadilah", "9C", "9C_Alya"], ["Aisyah Rahmawati", "9C", "9C_Aisyah"], ["Citra Lestari", "9C", "9C_Citra"], ["Dinda Ayu Permata", "9C", "9C_Dinda"], ["Fitri Handayani", "9C", "9C_Fitri"], ["Ghina Azzahra", "9C", "9C_Ghina"], ["Hana Safitri", "9C", "9C_Hana"], ["Intan Sari", "9C", "9C_Intan"], ["Karina Putri", "9C", "9C_Karina"], ["Nabila Zahra", "9C", "9C_Nabila"],
  ["Aditya Pratama", "9D", "9D_Aditya"], ["Bayu Firmansyah", "9D", "9D_Bayu"], ["Daffa Alfarizi", "9D", "9D_Daffa"], ["Fikri Ramadhan", "9D", "9D_Fikri"], ["Hafiz Maulana", "9D", "9D_Hafiz"], ["Kevin Pratama", "9D", "9D_Kevin"], ["Muhammad Farhan", "9D", "9D_Muhammad"], ["Rangga Saputra", "9D", "9D_Rangga"], ["Satria Wibowo", "9D", "9D_Satria"], ["Zidan Alamsyah", "9D", "9D_Zidan"],
].map(([name, className, username], index) => ({ id: index + 1, name, className, username, password: "123" }));

function createId() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + "-" + Math.random().toString(16).slice(2); }

function formatDate() {
  return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
}

function Logo() { return <div className="brand"><span className="brand-mark"><BookOpen size={22} weight="bold" /></span><span>Absensi<span>Sholat</span></span></div>; }

export default function Home() {
  const [students, setStudents] = useState(initialStudents);
  const [attendances, setAttendances] = useState([]);
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("Semua kelas");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const storedStudents = localStorage.getItem("dzuhur-students");
    const storedAttendances = localStorage.getItem("dzuhur-attendances");
    if (storedStudents) setStudents(JSON.parse(storedStudents));
    if (storedAttendances) setAttendances(JSON.parse(storedAttendances));
    const storedSession = localStorage.getItem("dzuhur-session");
    if (storedSession) setUser(JSON.parse(storedSession));
  }, []);
  useEffect(() => { localStorage.setItem("dzuhur-students", JSON.stringify(students)); }, [students]);
  useEffect(() => { localStorage.setItem("dzuhur-attendances", JSON.stringify(attendances)); }, [attendances]);

  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const todayAttendance = attendances.filter((item) => item.date === todayKey);
  const filteredStudents = useMemo(() => students.filter((student) => (classFilter === "Semua kelas" || student.className === classFilter) && `${student.name} ${student.username}`.toLowerCase().includes(query.toLowerCase())), [students, classFilter, query]);

  function login(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = form.get("username").trim();
    const password = form.get("password");
    if (username === "guru" && password === "123") { const session = { name: "Guru Admin", role: "admin" }; setUser(session); localStorage.setItem("dzuhur-session", JSON.stringify(session)); setView("dashboard"); return; }
    const student = students.find((item) => item.username === username && item.password === password);
    if (student) { const session = { ...student, role: "student" }; setUser(session); localStorage.setItem("dzuhur-session", JSON.stringify(session)); setView("dzuhur"); return; }
    setNotice("Username atau password belum sesuai.");
  }

  function confirmPrayer() {
    if (attendances.some((item) => item.studentId === user.id && item.date === todayKey)) return;
    setAttendances([{ id: createId(), studentId: user.id, studentName: user.name, className: user.className, date: todayKey, time: new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date()) }, ...attendances]);
  }

  function saveStudent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = { id: editing?.id || createId(), name: form.get("name"), className: form.get("className"), username: form.get("username"), password: form.get("password") };
    if (students.some((item) => item.username === value.username && item.id !== value.id)) { setNotice("Username sudah digunakan."); return; }
    setStudents(editing ? students.map((item) => item.id === value.id ? value : item) : [...students, value]);
    setEditing(null);
  }

  if (!user) return <Login notice={notice} onLogin={login} />;
  if (user.role === "student") return <StudentPage user={user} attendances={attendances} todayKey={todayKey} onConfirm={confirmPrayer} onLogout={() => { localStorage.removeItem("dzuhur-session"); setUser(null); }} />;
  return <AdminApp students={students} attendances={todayAttendance} view={view} setView={setView} query={query} setQuery={setQuery} classFilter={classFilter} setClassFilter={setClassFilter} filteredStudents={filteredStudents} editing={editing} setEditing={setEditing} onSave={saveStudent} onDelete={(id) => setStudents(students.filter((item) => item.id !== id))} onLogout={() => { localStorage.removeItem("dzuhur-session"); setUser(null); }} />;
}

function Login({ notice, onLogin }) { return <main className="login-shell"><section className="login-story"><Logo /><div><p className="eyebrow">ABSENSI SHOLAT DZUHUR</p><h1>Hadirkan kebiasaan baik, catat dengan sederhana.</h1><p>Konfirmasi kehadiran setelah sholat Dzuhur dalam satu halaman yang mudah dipakai.</p></div><div className="story-note"><CheckCircle size={22} weight="fill" /> Satu QR tetap untuk semua murid</div></section><section className="login-panel"><form onSubmit={onLogin} className="login-form"><p className="eyebrow">MASUK APLIKASI</p><h2>Selamat datang</h2><p className="muted">Gunakan akun guru atau akun murid yang terdaftar.</p>{notice && <p className="form-error"><WarningCircle size={18} />{notice}</p>}<label>Username<input name="username" autoComplete="username" placeholder="Contoh: 9A_Irfan" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" placeholder="Masukkan password" required /></label><button className="primary" type="submit">Masuk ke aplikasi</button><p className="login-help">Demo guru: <strong>guru</strong> dengan password <strong>123</strong></p></form></section></main>; }

function StudentPage({ user, attendances, todayKey, onConfirm, onLogout }) { const recorded = attendances.find((item) => item.studentId === user.id && item.date === todayKey); return <main className="student-shell"><header><Logo /><button className="text-button" onClick={onLogout}>Keluar <SignOut size={18} /></button></header><section className="confirm-card"><div className="prayer-icon"><CheckCircle size={34} weight="bold" /></div>{recorded ? <><p className="eyebrow">SUDAH TERCATAT</p><h1>Terima kasih, {user.name.split(" ")[0]}.</h1><p>Absensi sholat Dzuhur Anda tercatat pukul <strong>{recorded.time}</strong>.</p></> : <><p className="eyebrow">KONFIRMASI DZUHUR</p><h1>Apakah Anda sudah sholat Dzuhur?</h1><p>{user.name} · Kelas {user.className}</p><button className="primary large" onClick={onConfirm}>Saya sudah sholat Dzuhur</button></>}<p className="privacy-note">Konfirmasi hanya dapat dilakukan satu kali setiap hari.</p></section></main>; }

function AdminApp(props) { const { students, attendances, view, setView, query, setQuery, classFilter, setClassFilter, filteredStudents, editing, setEditing, onSave, onDelete, onLogout } = props; const present = attendances.length; const absent = students.length - present; return <div className="app-shell"><aside><Logo /><nav><NavButton active={view === "dashboard"} onClick={() => setView("dashboard")} icon={<House size={20} />}>Ringkasan</NavButton><NavButton active={view === "students"} onClick={() => setView("students")} icon={<UsersThree size={20} />}>Data murid</NavButton><NavButton active={view === "qr"} onClick={() => setView("qr")} icon={<QrCode size={20} />}>QR Dzuhur</NavButton><NavButton active={view === "settings"} onClick={() => setView("settings")} icon={<Gear size={20} />}>Pengaturan</NavButton></nav><button className="side-logout" onClick={onLogout}><SignOut size={20} />Keluar</button></aside><main className="admin-main"><header className="admin-header"><div><p className="eyebrow">{formatDate()}</p><h1>{view === "dashboard" ? "Ringkasan hari ini" : view === "students" ? "Data murid" : view === "qr" ? "QR sholat Dzuhur" : "Pengaturan"}</h1></div><div className="admin-avatar">GA</div></header>{view === "dashboard" && <Dashboard present={present} absent={absent} total={students.length} attendances={attendances} />}{view === "students" && <Students students={filteredStudents} query={query} setQuery={setQuery} classFilter={classFilter} setClassFilter={setClassFilter} setEditing={setEditing} onDelete={onDelete} />}{view === "qr" && <QrPage />}{view === "settings" && <section className="simple-panel"><ClipboardText size={28} /><h2>Pengaturan aplikasi</h2><p>QR permanen mengarah ke halaman Dzuhur. Nanti domain VPS dapat diatur dari bagian ini.</p></section>}</main>{editing !== null && <StudentModal student={editing} onClose={() => setEditing(null)} onSave={onSave} />}</div>; }
function NavButton({ active, onClick, icon, children }) { return <button onClick={onClick} className={active ? "nav-active" : ""}>{icon}{children}</button>; }
function Dashboard({ present, absent, total, attendances }) { return <><section className="metric-grid"><Metric label="Sudah hadir" value={present} detail="Murid terkonfirmasi" tone="green" /><Metric label="Belum hadir" value={absent} detail="Perlu ditinjau" tone="sand" /><Metric label="Total murid" value={total} detail="Dari empat kelas" tone="plain" /></section><section className="attendance-panel"><div className="panel-title"><div><h2>Absensi terbaru</h2><p>Konfirmasi yang masuk hari ini.</p></div><span>{present} murid hadir</span></div>{attendances.length ? <div className="attendance-list">{attendances.map((item) => <div key={item.id}><span className="person-initial">{item.studentName[0]}</span><strong>{item.studentName}</strong><span>{item.className}</span><time>{item.time}</time></div>)}</div> : <div className="empty"><CheckCircle size={28} />Belum ada konfirmasi Dzuhur hari ini.</div>}</section></>; }
function Metric({ label, value, detail, tone }) { return <article className={`metric ${tone}`}><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>; }
function Students({ students, query, setQuery, classFilter, setClassFilter, setEditing, onDelete }) { return <section className="students-panel"><div className="table-actions"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari nama atau username" /><select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}><option>Semua kelas</option><option>9A</option><option>9B</option><option>9C</option><option>9D</option></select><button className="primary compact" onClick={() => setEditing({ name: "", className: "9A", username: "", password: "123" })}><Plus size={18} />Tambah murid</button></div><div className="data-table"><div className="table-head"><span>Nama lengkap</span><span>Kelas</span><span>Username</span><span>Password</span><span>Aksi</span></div>{students.map((student) => <div className="table-row" key={student.id}><strong>{student.name}</strong><span><b className="class-chip">{student.className}</b></span><span>{student.username}</span><span className="password-text">{student.password}</span><span className="row-actions"><button aria-label="Edit murid" onClick={() => setEditing(student)}><PencilSimple size={18} /></button><button aria-label="Hapus murid" onClick={() => onDelete(student.id)}><Trash size={18} /></button></span></div>)}</div></section>; }
function QrPage() { const url = typeof window === "undefined" ? "https://domain-sekolah.id/dzuhur" : `${window.location.origin}/dzuhur`; return <section className="qr-panel"><div><p className="eyebrow">SATU QR PERMANEN</p><h2>Tempelkan QR ini di area sholat.</h2><p>Setelah murid login, QR membuka halaman konfirmasi sholat Dzuhur.</p><code>{url}</code><a className="primary qr-link" href="/dzuhur">Buka halaman Dzuhur</a></div><div className="qr-print"><QRCodeSVG value={url} size={214} bgColor="#ffffff" fgColor="#123d2a" includeMargin /><strong>AbsensiSholat</strong><span>Scan setelah sholat</span></div></section>; }
function StudentModal({ student, onClose, onSave }) { return <div className="modal-backdrop"><form className="student-modal" onSubmit={onSave}><div><p className="eyebrow">{student.id ? "EDIT MURID" : "TAMBAH MURID"}</p><h2>{student.id ? "Perbarui data murid" : "Masukkan data murid baru"}</h2></div><label>Nama lengkap<input name="name" defaultValue={student.name} required /></label><label>Kelas<select name="className" defaultValue={student.className}><option>9A</option><option>9B</option><option>9C</option><option>9D</option></select></label><label>Username<input name="username" defaultValue={student.username} required /></label><label>Password<input name="password" defaultValue={student.password} required /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Batal</button><button type="submit" className="primary">Simpan data</button></div></form></div>; }
