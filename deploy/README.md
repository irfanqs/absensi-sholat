# Deployment Nginx

Nginx menerima request pada port 80 dan meneruskannya ke aplikasi Next.js pada `127.0.0.1:3000`.

Konfigurasi aktif pada server:

- `/etc/nginx/sites-available/absensi-dzuhur`
- `/etc/systemd/system/absensi-dzuhur.service`

Setelah pembaruan aplikasi, jalankan `npm run build` lalu `sudo systemctl restart absensi-dzuhur`.

Firewall UFW harus mengizinkan HTTP agar IP server dapat diakses tanpa port:

```bash
sudo ufw allow 80/tcp
```
