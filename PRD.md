# PRD — Absensi Sholat Dzuhur

## 1. Ringkasan produk

Aplikasi web absensi Sholat Dzuhur untuk sekolah. Murid yang telah login memindai **satu QR permanen** di area sholat. QR membuka halaman konfirmasi; setelah murid memilih **"Saya sudah sholat Dzuhur"**, sistem mencatat kehadiran hari itu.

Produk hanya mempunyai dua peran:

- **Guru / Admin** — mengelola seluruh data dan memantau rekap absensi.
- **Murid** — login dan mengonfirmasi sholat setelah memindai QR.

## 2. Tujuan

- Menggantikan pencatatan absensi Dzuhur manual.
- Memudahkan guru melihat kehadiran murid lintas kelas.
- Menyediakan proses murid yang cepat tanpa memasang aplikasi.
- Menjaga satu data absensi per murid per hari.

## 3. Bukan cakupan versi awal

- Absensi sholat selain Dzuhur.
- QR dinamis atau QR pribadi per murid.
- Validasi GPS, Wi-Fi sekolah, foto, maupun biometrik.
- Notifikasi ke orang tua.
- Multi-sekolah.

## 4. Pengguna dan hak akses

### Guru / Admin

- Login ke dashboard admin.
- Melihat ringkasan kehadiran hari ini dan per kelas.
- Menambah, melihat, mengubah, dan menghapus data murid.
- Mengelola kelas.
- Melihat, memfilter, dan mengekspor rekap absensi berdasarkan tanggal, kelas, atau murid.
- Membetulkan atau menghapus catatan absensi jika diperlukan.

### Murid

- Login dengan username dan password.
- Memindai QR permanen.
- Membuka halaman konfirmasi Dzuhur.
- Mengirim konfirmasi satu kali per hari.
- Melihat hasil konfirmasi dan riwayat absensi pribadinya (opsional untuk versi pertama).

## 5. Alur utama murid

1. Murid login ke website menggunakan akun yang telah dibuat admin.
2. Murid memindai QR yang ditempel di lokasi sholat.
3. QR mengarah ke `https://domain-sekolah.id/dzuhur`.
4. Sistem memeriksa sesi login murid.
   - Jika belum login, arahkan ke halaman login lalu kembali ke halaman Dzuhur.
   - Jika sudah login, tampilkan halaman konfirmasi.
5. Murid menekan tombol **"Saya sudah sholat Dzuhur"**.
6. Sistem menyimpan waktu absensi dan menampilkan status berhasil.
7. Jika murid sudah tercatat pada tanggal yang sama, tampilkan informasi bahwa absensi hari ini sudah tercatat tanpa membuat data baru.

## 6. Aturan bisnis

- Hanya ada **satu QR permanen** untuk seluruh murid; QR berisi URL, bukan identitas murid.
- Identitas absensi diambil dari akun murid yang sedang login.
- Satu murid hanya dapat memiliki satu absensi Dzuhur per tanggal menurut zona waktu `Asia/Jakarta`.
- Murid dapat berasal dari kelas mana pun.
- Guru/admin dapat mengelola seluruh murid dan rekap lintas kelas.
- Data murid yang dihapus tidak boleh menghapus rekap lama; gunakan penonaktifan akun (soft delete) sebagai pilihan aman pada implementasi produksi.
- Password data dummy adalah `123` hanya untuk pengembangan. Di produksi password wajib disimpan sebagai hash (mis. Argon2id atau bcrypt), tidak pernah sebagai teks biasa.

## 7. Halaman aplikasi

| Halaman | Pengguna | Fungsi |
| --- | --- | --- |
| Login | Semua | Masuk dengan username dan password. |
| `/dzuhur` | Murid | Konfirmasi sudah sholat Dzuhur setelah scan QR. |
| Dashboard admin | Guru/admin | Ringkasan jumlah hadir hari ini dan daftar absensi terbaru. |
| Data murid | Guru/admin | Tabel dengan empat kolom: Nama Lengkap, Kelas, Username, Password; admin dapat menambah, melihat, mengedit, menonaktifkan, atau menghapus murid. |
| Data kelas | Guru/admin | Kelola kelas. |
| Rekap absensi | Guru/admin | Filter tanggal/kelas/murid dan ekspor CSV/Excel. |
| Profil/riwayat | Murid | Riwayat absensi pribadi (opsional V1). |

## 8. Data inti

### `users`

`id`, `username`, `password_hash`, `role`, `is_active`, `created_at`, `updated_at`

### `classes`

`id`, `name`, `created_at`, `updated_at`

### `students`

`id`, `user_id`, `class_id`, `nis`, `full_name`, `is_active`, `created_at`, `updated_at`

### `attendances`

`id`, `student_id`, `attendance_date`, `checked_in_at`, `prayer_type`, `source`, `created_at`, `updated_at`

Kendala unik wajib: `(student_id, attendance_date, prayer_type)`. Untuk versi ini, `prayer_type` selalu bernilai `DZUHUR`.

## 9. Kriteria penerimaan versi pertama

- QR permanen dapat dipindai dan membuka halaman Dzuhur.
- Murid yang belum login diminta login sebelum dapat mengonfirmasi.
- Konfirmasi murid tersimpan dengan nama, kelas, tanggal, dan waktu.
- Konfirmasi kedua pada hari yang sama tidak membuat catatan tambahan.
- Guru/admin dapat menambah, mengedit, dan menonaktifkan/menghapus murid.
- Guru/admin dapat melihat rekap berdasarkan tanggal dan kelas.
- Data dummy berisi empat kelas dengan masing-masing sepuluh murid.

## 10. Stack implementasi yang direncanakan

- Next.js + TypeScript untuk aplikasi web dan API.
- PostgreSQL untuk database.
- Prisma ORM untuk skema, migrasi, dan akses data.
- Auth.js atau autentikasi session berbasis cookie untuk login dan role.
- Tailwind CSS untuk antarmuka.
- Nginx, Docker Compose, dan HTTPS Let's Encrypt pada satu VPS.

