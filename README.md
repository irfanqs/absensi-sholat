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
- Tampilan responsif untuk HP.

## Akun demo

| Role | Username | Password |
| --- | --- | --- |
| Guru/admin | `guru` | `123` |
| Murid | `9A_Irfan` | `123` |

Data contoh mencakup 40 murid dari kelas 9A sampai 9D. Lihat [data/dummy-students.csv](data/dummy-students.csv).

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

Versi saat ini adalah MVP. Data murid, sesi login, dan absensi disimpan di `localStorage` browser untuk kebutuhan demonstrasi, sehingga belum cocok untuk pencatatan resmi lintas perangkat. Untuk penggunaan produksi sekolah, langkah berikutnya adalah menggunakan PostgreSQL, autentikasi berbasis cookie aman, password hash, dan backup database.

## Struktur penting

```text
app/                 Halaman aplikasi Next.js
app/dzuhur/          Rute yang dibuka QR permanen
data/                Data murid dummy CSV
deploy/              Konfigurasi Nginx dan systemd
PRD.md               Kebutuhan produk
```
