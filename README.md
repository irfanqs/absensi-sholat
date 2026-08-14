# AbsensiSholat

AbsensiSholat adalah aplikasi web untuk **SMA Negeri 9 Semarang** yang membantu guru memantau apakah murid telah melaksanakan sholat Dzuhur serta mempermudah pencatatan kehadiran sholat.

Murid cukup login lalu memindai satu QR permanen yang ditempel di area sholat. QR membuka halaman konfirmasi Dzuhur. Guru dapat melihat rekap kehadiran dan mengelola data murid dari dashboard.

## Fitur

- Dua role: guru/admin dan murid.
- Login menggunakan username dan password.
- Satu QR permanen untuk sholat Dzuhur.
- Konfirmasi sholat satu kali per murid per hari.
- Dashboard guru dengan ringkasan dan daftar absensi hari ini.
- Pengelolaan murid: tambah, edit, dan hapus.
- QR dapat diunduh sebagai PNG untuk dicetak.
- Rekap absensi harian, mingguan, dan bulanan untuk guru.
- Tampilan responsif untuk HP.
- Import murid dari Excel/CSV dengan halaman konfirmasi sebelum disimpan.

## Akun demo

| Role | Username | Password |
| --- | --- | --- |
| Guru/admin | `guru` | `123` |
| Murid | `9A_Irfan` | `123` |

Data contoh mencakup 40 murid dari kelas 9A sampai 9D. Lihat [data/dummy-students.csv](data/dummy-students.csv).

## Supabase dan Vercel

Aplikasi sudah memiliki client Supabase dan schema database di [supabase/schema.sql](supabase/schema.sql). Untuk mengaktifkan penyimpanan terpusat:

1. Buat project di Supabase.
2. Jalankan isi `supabase/schema.sql` di SQL Editor Supabase.
3. Salin `.env.example` menjadi `.env.local` untuk lokal.
4. Isi `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
5. Tambahkan environment variable yang sama di Vercel.

Tanpa environment variable, aplikasi masih memakai `localStorage` sebagai fallback lokal. Schema saat ini memakai policy publik agar alur login demo lama tetap berjalan. Sebelum digunakan secara resmi, migrasikan login ke Supabase Auth dan ganti policy RLS agar data tidak dapat dibaca atau diubah publik.

## Prasyarat

- Node.js 22 atau lebih baru.
- npm.
- Untuk deployment VPS: Nginx dan systemd.

## Instalasi lokal

```bash
git clone <URL_REPOSITORI>
cd absensi-sholat
npm install
npm run dev
```

Buka `http://localhost:3000`.

## Menjalankan production build

```bash
npm install
npm run build
npm run start
```

Aplikasi akan berjalan pada port `3000` secara default.

## Deployment VPS dengan Nginx

1. Salin proyek ke VPS dan pasang dependensi.

   ```bash
   npm install
   npm run build
   ```

2. Salin konfigurasi layanan dan Nginx dari folder [deploy](deploy).

   ```bash
   sudo cp deploy/absensi-dzuhur.service /etc/systemd/system/
   sudo cp deploy/absensi-dzuhur.nginx.conf /etc/nginx/sites-available/absensi-dzuhur
   sudo ln -s /etc/nginx/sites-available/absensi-dzuhur /etc/nginx/sites-enabled/absensi-dzuhur
   ```

3. Uji konfigurasi dan aktifkan layanan.

   ```bash
   sudo nginx -t
   sudo systemctl daemon-reload
   sudo systemctl enable --now absensi-dzuhur
   sudo systemctl restart nginx
   ```

4. Buka HTTP pada firewall.

   ```bash
   sudo ufw allow 80/tcp
   ```

Setelah itu aplikasi dapat diakses menggunakan alamat IP VPS tanpa menulis `:3000`.

Untuk menerapkan kode baru di VPS:

```bash
git pull
npm install
npm run build
sudo systemctl restart absensi-dzuhur
```

## Catatan penting

Data murid dan absensi akan disimpan di Supabase jika environment variable tersedia. Sesi login dan status spin masih memakai browser karena autentikasi aplikasi saat ini masih berbasis demo. Untuk pencatatan resmi, gunakan Supabase Auth, password hash, RLS berbasis role, dan backup database.

## Struktur penting

```text
app/                 Halaman aplikasi Next.js
app/dzuhur/          Rute yang dibuka QR permanen
data/                Data murid dummy CSV
deploy/              Konfigurasi Nginx dan systemd
PRD.md               Kebutuhan produk
```
