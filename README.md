# Auralis AI

Struktur:
- `public/` frontend (index.html, PWA)
- `api/chat.js` proxy Vercel Edge (API key hanya ada di server)

## Deploy (GitHub + Vercel)
1. Buat repo GitHub, upload seluruh isi folder ini (`git init`, `git add .`, `git commit`, `git push`).
2. Di vercel.com: Add New > Project > import repo tersebut. Framework: Other. Tidak perlu build command.
3. Project Settings > Environment Variables: isi key penyedia yang kamu pakai (lihat `.env.example`). Cukup isi yang dipakai; model penyedia tanpa key otomatis nonaktif.
4. Redeploy. Buka domain `*.vercel.app`.

## Frontend di GitHub Pages (opsional)
GitHub Pages hanya hosting statis, jadi proxy tetap di Vercel:
1. Isi `ALLOWED_ORIGINS=https://USERNAME.github.io` di Vercel env, lalu redeploy.
2. Di `public/index.html`, tepat sebelum `<script>` utama, tambahkan:
   `<script>window.AURALIS_API="https://NAMA-PROJECT.vercel.app/api/chat"</script>`
3. Aktifkan Pages dari folder `public` (atau salin isinya ke branch gh-pages).

## Menambah model
Tambahkan ID di `MODELS` pada `api/chat.js` DAN di daftar `MODELS` pada `public/index.html`.

## Catatan keamanan
- Jangan pernah menaruh key di `public/` atau meng-commit `.env`.
- Rate limit bawaan bersifat per IP dan per instance. Untuk kuota per pengguna yang sungguhan, tambahkan autentikasi server (mis. Supabase) dan Vercel KV/Upstash.
