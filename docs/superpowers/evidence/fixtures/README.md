# Fixture checklist manual

File uji untuk `docs/superpowers/evidence/manual-checklist.md` (Task 9). Semua data di sini
dummy; dipakai di staging atau Preview (env Preview Vercel menunjuk ke database staging),
jangan di production.

- `t9-import-150.csv` — 149 murid baru `t9_imp_001`–`t9_imp_149` + 1 baris dengan NIS
  `9a_bima` (bentrok beda huruf dengan `9A_Bima`, dilaporkan sebagai `duplicate`).
- `t9-import-error.csv` — 1 murid baru (`t9_baik`), 1 username berspasi (`t9 salah`),
  1 username `9A_IRFAN` (bentrok).
- `cleanup-test-students.mjs` — membersihkan semua murid uji setelah checklist selesai.

## Membersihkan murid uji

Semua murid uji memakai username berawalan `t9_`.

1. Cara tanpa terminal (UI admin): Data Murid > ikon tempat sampah > `Nonaktifkan murid`
   untuk setiap murid uji. Murid nonaktif tidak bisa login dan tidak tampil, tetapi
   barisnya tetap ada di database.
2. Cara tuntas (service role, dari root repo, hanya staging):

   ```bash
   scripts/staging.sh run node --experimental-websocket \
     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
     docs/superpowers/evidence/fixtures/cleanup-test-students.mjs --confirm-ref=<ref staging>
   ```

   Menghapus absensi, akun Auth, dan baris murid uji. Hasil akhir harus
   `murid aktif sekarang 40` (data seed staging).
