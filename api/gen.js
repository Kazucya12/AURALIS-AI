// Vercel Edge Function: generator gambar dan video lewat Replicate. Letakkan sebagai api/gen.js
// Env wajib: REPLICATE_API_TOKEN (replicate.com/account/api-tokens)
// Env opsional: IMAGE_MODEL (bawaan black-forest-labs/flux-schnell), VIDEO_MODEL (kosong = fitur video mati; isi mis. "owner/nama-model"),
//   IMAGE_INPUT / VIDEO_INPUT (JSON tambahan untuk input model), GEN_IMG_DAILY (bawaan 30), GEN_VID_DAILY (bawaan 5),
//   REPLICATE_URL (bawaan https://api.replicate.com/v1), PRO_SECRET + KV_REST_API_URL/TOKEN (batas harian per lisensi).
// BARU v2 (beda Gratis vs Pro, hanya aktif bila PRO_SECRET terpasang):
//   IMAGE_MODEL_PRO / VIDEO_MODEL_PRO: model yang lebih bagus khusus Pro (kosong = sama dengan model Gratis).
//   GEN_IMG_DAILY_PRO (100), GEN_VID_DAILY_PRO (15), GEN_EDIT_DAILY_PRO (60): batas harian Pro. Gratis: 30 / 3 / 10 (bisa diubah lewat env di atas dan GEN_EDIT_DAILY).
//   TOKEN_LIMIT_FREE (bawaan 40000), TOKEN_LIMIT_PRO (bawaan 400000): samakan dengan window.AURALIS_LIMITS di index.html.
// BARU: gambar lewat Cloudflare Workers AI (gratis/murah): isi CF_ACCOUNT_ID + CF_API_TOKEN (opsional CF_IMAGE_MODEL, bawaan @cf/black-forest-labs/flux-1-schnell).
//   Bila terisi, gambar Gratis dibuat lewat Cloudflare; Pro tetap memakai IMAGE_MODEL_PRO (Replicate) bila diisi. Video dan edit tetap butuh Replicate.
// BARU: foto jadi video (tren TikTok): aplikasi mengirim foto bersama prompt ke model video. Pilih model IMAGE-TO-VIDEO di VIDEO_MODEL dan isi VIDEO_IMAGE_FIELD sesuai nama input fotonya (bawaan image).
// Biaya token: GEN_IMG_TOKENS (bawaan 1500), GEN_VID_TOKENS (6000), GEN_EDIT_TOKENS (3000); aplikasi membaca angka ini dari server.
// Edit gambar: isi IMAGE_EDIT_MODEL (mis. "black-forest-labs/flux-kontext-pro"), IMAGE_EDIT_FIELD (nama input gambar, bawaan input_image), EDIT_INPUT (JSON tambahan).
// Plafon biaya global per hari (semua pengguna): GEN_IMG_GLOBAL_DAILY (300), GEN_VID_GLOBAL_DAILY (30), GEN_EDIT_GLOBAL_DAILY (100).
// Gambar atau video yang gagal dibuat penyedia dikembalikan tokennya otomatis.
export const config = { runtime: 'edge' };

const TOKEN = (process.env.REPLICATE_API_TOKEN || '').trim();
const BASE = (process.env.REPLICATE_URL || 'https://api.replicate.com/v1').trim().replace(/\/+$/, '');
const CF_ACC = (process.env.CF_ACCOUNT_ID || '').trim(), CF_TOK = (process.env.CF_API_TOKEN || '').trim(), CF = !!(CF_ACC && CF_TOK);
const CF_MODEL = (process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell').trim();
const IMG_MODEL = (process.env.IMAGE_MODEL || 'black-forest-labs/flux-schnell').trim();
const VID_MODEL = (process.env.VIDEO_MODEL || '').trim();
const IMG_MODEL_PRO = (process.env.IMAGE_MODEL_PRO || '').trim();
const VID_MODEL_PRO = (process.env.VIDEO_MODEL_PRO || '').trim();
const EDIT_MODEL = (process.env.IMAGE_EDIT_MODEL || '').trim();
const VID_FIELD = (process.env.VIDEO_IMAGE_FIELD || 'image').trim(); // nama input foto di model video (mis. image, start_image, first_frame_image)
const EDIT_FIELD = (process.env.IMAGE_EDIT_FIELD || 'input_image').trim();
const LIM = {
  free: { image: +process.env.GEN_IMG_DAILY || 30, video: +process.env.GEN_VID_DAILY || 3, edit: +process.env.GEN_EDIT_DAILY || 10 },
  pro: { image: +process.env.GEN_IMG_DAILY_PRO || 100, video: +process.env.GEN_VID_DAILY_PRO || 15, edit: +process.env.GEN_EDIT_DAILY_PRO || 60 },
};
const CAP = { image: +process.env.GEN_IMG_GLOBAL_DAILY || 300, video: +process.env.GEN_VID_GLOBAL_DAILY || 30, edit: +process.env.GEN_EDIT_GLOBAL_DAILY || 100 };
const KIND_ID = { image: 'gambar', video: 'video', edit: 'edit gambar' };
const PRO_SECRET = (process.env.PRO_SECRET || '').trim();
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const FILE_HOSTS = (process.env.GEN_FILE_HOSTS || 'replicate.delivery,replicate.com').split(',').map(s => s.trim()).filter(Boolean);
const enc = new TextEncoder();
const j = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
// Mengembalikan {pro, id} : id = kode lisensi (untuk kuota) atau null
async function lic(req) {
  if (!PRO_SECRET) return { pro: true, id: null };
  const t = req.headers.get('x-license') || '';
  const [body, sig] = t.split('.');
  if (!body || !sig) return { pro: false };
  try {
    const k = await crypto.subtle.importKey('raw', enc.encode(PRO_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', k, unb64u(sig), enc.encode(body)))) return { pro: false };
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return p.p === 'pro' && p.e > Date.now() ? { pro: true, id: String(p.c || '') || null, who: 'L' + String(p.c || p.e) } : { pro: false };
  } catch { return { pro: false }; }
}
const TOK_FREE = +process.env.TOKEN_LIMIT_FREE || 40000, TOK_PRO = +process.env.TOKEN_LIMIT_PRO || 400000, TOK_WIN = 6 * 3600;
const COST = { image: +process.env.GEN_IMG_TOKENS || 1500, video: +process.env.GEN_VID_TOKENS || 6000, edit: +process.env.GEN_EDIT_TOKENS || 3000 };
const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
async function tokKey(who) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(who))); return 'auralis:tk:' + [...h.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function stat(name, by) { try { const k = 'auralis:st:' + dayKey() + ':' + name, n = await kv(['INCRBY', k, by || 1]); if (n === (by || 1)) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }
const RLD = async (kind, ip, lim, win = 600) => { // batas laju bersama lewat Upstash, cadangan memori
  if (KV_URL && KV_TOKEN) {
    try {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('rl' + ip))), hx = [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
      const key = 'auralis:rl:g' + kind + ':' + hx + ':' + Math.floor(Date.now() / (win * 1000)), n = await kv(['INCR', key]);
      if (n === 1) await kv(['EXPIRE', key, win * 2]);
      return n > lim;
    } catch {}
  }
  return limited(kind + ip, lim, win * 1000);
};
const hits = new Map();
function limited(key, n, win) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win);
  if (a.length >= n) return true;
  a.push(now); hits.set(key, a); return false;
}
const okHost = h => FILE_HOSTS.some(x => h === x || h.endsWith('.' + x));

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-license', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st, code) => J({ error: { message: m, code } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  const u = new URL(req.url);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();

  if (req.method === 'GET') {
    const f = u.searchParams.get('f');
    if (f) { // proxy berkas hasil (menghindari CORS); hanya host Replicate
      if (!TOKEN) return E('Generator belum diatur', 503);
      if (limited('f:' + ip, 60, 10 * 60e3)) return E('Terlalu banyak permintaan', 429);
      let t; try { t = new URL(f); } catch { return E('URL tidak valid', 400); }
      if (t.protocol !== 'https:' && !(BASE.startsWith('http:') && t.protocol === 'http:')) return E('URL tidak valid', 400);
      if (!okHost(t.hostname) && !(BASE.startsWith('http:') && t.hostname === new URL(BASE).hostname)) return E('Host tidak diizinkan', 403);
      const r = await fetch(t.href);
      if (!r.ok) return E('Berkas tidak tersedia (mungkin sudah kedaluwarsa)', 404);
      return new Response(r.body, { status: 200, headers: { ...cors, 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=600' } });
    }
    const L0 = await lic(req), lim0 = PRO_SECRET && L0.pro ? LIM.pro : LIM.free;
    return J({ enabled: !!(TOKEN || CF), image: !!(TOKEN || CF), video: !!(TOKEN && (VID_MODEL || VID_MODEL_PRO)), edit: !!(TOKEN && EDIT_MODEL), limits: lim0, costs: COST });
  }
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!TOKEN && !CF) return E('Generator belum diatur di server (REPLICATE_API_TOKEN atau CF_ACCOUNT_ID + CF_API_TOKEN)', 503);
  if (+req.headers.get('content-length') > 1.6e6) return E('Permintaan terlalu besar', 413);
  const L = await lic(req); // akun gratis juga boleh; dibatasi kuota token dan batas harian
  const tier = PRO_SECRET && L.pro ? 'pro' : 'free'; // tanpa PRO_SECRET sistem Pro mati, semua pengguna diperlakukan sebagai Gratis
  const d = await req.json().catch(() => null);
  if (!d) return E('Body tidak valid', 400);
  // polling status sering (video bisa ratusan kali), jadi batasnya dipisah dari batas membuat
  if (d.action === 'status' ? limited('s:' + ip, 400, 10 * 60e3) : (d.action === 'create' ? await RLD('c', ip, 40) : limited('p:' + ip, 40, 10 * 60e3))) return E('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
  const hdr = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };

  if (d.action === 'create') {
    const kind = d.kind === 'video' ? 'video' : d.kind === 'edit' ? 'edit' : 'image';
    const model = kind === 'video' ? (tier === 'pro' && VID_MODEL_PRO) || VID_MODEL || VID_MODEL_PRO
      : kind === 'edit' ? EDIT_MODEL
      : (tier === 'pro' && IMG_MODEL_PRO) || IMG_MODEL;
    if (!model) return E(kind === 'video' ? 'Pembuat video belum diaktifkan di server (VIDEO_MODEL)' : 'Edit gambar belum diaktifkan di server (IMAGE_EDIT_MODEL)', 503);
    if (kind !== 'image' && !TOKEN) return E('Video dan edit gambar butuh REPLICATE_API_TOKEN di server', 503);
    const useCF = kind === 'image' && CF && !(tier === 'pro' && IMG_MODEL_PRO && TOKEN);
    const prompt = String(d.prompt || '').trim().slice(0, 1500);
    if (prompt.length < 3) return E('Tulis deskripsi dulu', 400);
    const image = kind === 'edit' || kind === 'video' ? String(d.image || '') : '';
    if ((kind === 'edit' || (kind === 'video' && image)) && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(image) || image.length > 1.4e6)) return E('Gambar yang diedit tidak valid atau terlalu besar', 400);
    const ratio = ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(d.ratio) ? d.ratio : '1:1';
    const dayLim = LIM[tier][kind];
    // kuota token (dipotong setelah penyedia menerima permintaan)
    let tk = null;
    if (PRO_SECRET && KV_URL && KV_TOKEN) {
      try {
        const key = await tokKey(L.who || 'I' + ip), limit = L.pro ? TOK_PRO : TOK_FREE, used = +(await kv(['GET', key])) || 0;
        if (used + COST[kind] > limit) {
          const ttl = used ? await kv(['PTTL', key]) : -2, mnt = Math.ceil((ttl > 0 ? ttl : TOK_WIN * 1000) / 60000);
          return E(`Kuota token tidak cukup untuk ${KIND_ID[kind]} (butuh sekitar ${COST[kind]}). Reset dalam ${Math.floor(mnt / 60)} jam ${mnt % 60} menit.`, 429, 'quota');
        }
        tk = { key };
      } catch {}
    }
    // kuota harian per pengguna + plafon biaya global per hari; dikembalikan bila penyedia gagal
    const taken = [], undo = async () => { for (const k of taken) { try { await kv(['DECR', k]); } catch {} } };
    if (KV_URL && KV_TOKEN) {
      try {
        const day = dayKey();
        const uk = `auralis:gen:${kind}:${L.id || 'ip-' + ip}:${day}`, gk = `auralis:gen:cap:${kind}:${day}`;
        for (const [k, lim, msg, code] of [
          [uk, dayLim, `Batas harian ${KIND_ID[kind]} tercapai (${dayLim}/hari${tier === 'free' && PRO_SECRET ? '; Pro mendapat ' + LIM.pro[kind] + '/hari' : ''}). Coba lagi besok.`, 'quota'],
          [gk, CAP[kind], `Kapasitas ${KIND_ID[kind]} hari ini sudah penuh untuk semua pengguna. Coba lagi besok.`, 'capacity'],
        ]) {
          const n = await kv(['INCR', k]); taken.push(k);
          if (n === 1) await kv(['EXPIRE', k, 90000]);
          if (n > lim) { await undo(); return E(msg, 429, code); }
        }
      } catch { await undo(); return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
    } else if (limited('q:' + (L.id || ip) + kind, dayLim, 864e5)) return E('Batas harian tercapai', 429, 'quota');
    if (useCF) { // Cloudflare Workers AI: hasil gambar dikirim langsung (tanpa polling)
      let r, p;
      try {
        r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/ai/run/${CF_MODEL}`, { method: 'POST', headers: { authorization: 'Bearer ' + CF_TOK, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, steps: 4 }), signal: AbortSignal.timeout(60000) });
        p = await r.json().catch(() => ({}));
      } catch { await undo(); return E('Penyedia tidak bisa dihubungi', 502); }
      const b64 = p && p.result && p.result.image;
      if (!r.ok || !b64) { await undo(); return E(String((p && p.errors && p.errors[0] && p.errors[0].message) || 'Cloudflare menolak permintaan').slice(0, 200), 502); }
      if (tk) { try { const r2 = await kv(['INCRBY', tk.key, COST[kind]]); if (r2 === COST[kind]) await kv(['EXPIRE', tk.key, TOK_WIN]); } catch {} }
      if (KV_URL && KV_TOKEN) await Promise.all([stat('tok', COST[kind]), stat('tm:gen-' + kind, COST[kind]), stat('tf:gen', COST[kind]), stat('gen_' + kind)]);
      return J({ ok: true, id: 'cf', kind, img: 'data:image/jpeg;base64,' + b64 });
    }
    const extra = j(process.env[kind === 'video' ? 'VIDEO_INPUT' : kind === 'edit' ? 'EDIT_INPUT' : 'IMAGE_INPUT'], {});
    const base = kind === 'image' ? { prompt, aspect_ratio: ratio, num_outputs: 1, output_format: 'webp' }
      : kind === 'edit' ? { prompt, [EDIT_FIELD]: image, aspect_ratio: 'match_input_image', output_format: 'jpg' }
            : image ? { prompt, [VID_FIELD]: image, aspect_ratio: ratio }
      : { prompt, aspect_ratio: ratio };
    const [name, ver] = model.split(':');
    const url = ver ? BASE + '/predictions' : BASE + '/models/' + name + '/predictions';
    const call = input => fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify(ver ? { version: ver, input } : { input }) });
    let r;
    try {
      r = await call({ ...base, ...extra });
      if (r.status === 422) r = await call(kind === 'edit' ? { prompt, [EDIT_FIELD]: image, ...extra } : image ? { prompt, [VID_FIELD]: image, ...extra } : { prompt, ...extra }); // model tidak mengenal parameter tambahan
    } catch { await undo(); return E('Penyedia tidak bisa dihubungi', 502); }
    const p = await r.json().catch(() => ({}));
    if (!r.ok || !p.id) { await undo(); return E(String(p.detail || p.title || 'Penyedia menolak permintaan').slice(0, 200), r.status === 402 ? 502 : (r.status >= 500 ? 502 : 400)); }
    if (tk) { try { const r2 = await kv(['INCRBY', tk.key, COST[kind]]); if (r2 === COST[kind]) await kv(['EXPIRE', tk.key, TOK_WIN]); } catch {} }
    if (KV_URL && KV_TOKEN) {
      // catat pembayar supaya token bisa dikembalikan bila penyedia melaporkan gagal (sekali pakai)
      try { await kv(['SET', 'auralis:gen:pr:' + p.id, kind + '|' + (tk ? tk.key : ''), 'EX', 7200]); } catch {}
      await Promise.all([stat('tok', COST[kind]), stat('tm:gen-' + kind, COST[kind]), stat('tf:gen', COST[kind]), stat('gen_' + kind)]); // statistik admin
    }
    return J({ ok: true, id: p.id, kind });
  }

  if (d.action === 'status') {
    const id = String(d.id || '');
    if (!/^[a-z0-9]{8,40}$/i.test(id)) return E('ID tidak valid', 400);
    let r;
    try { r = await fetch(BASE + '/predictions/' + id, { headers: hdr }); } catch { return E('Penyedia tidak bisa dihubungi', 502); }
    const p = await r.json().catch(() => ({}));
    if (!r.ok) return E('Tidak ditemukan', r.status === 404 ? 404 : 502);
    const out = Array.isArray(p.output) ? p.output[0] : p.output;
    const file = typeof out === 'string' ? out : (out && out.url) || null;
    if ((p.status === 'failed' || p.status === 'canceled') && KV_URL && KV_TOKEN) {
      try { // GETDEL: hanya satu kali pengembalian per prediksi, ke pembayar aslinya
        const v = await kv(['GETDEL', 'auralis:gen:pr:' + id]);
        if (v) {
          const [kd, key] = String(v).split('|');
          if (COST[kd]) {
            if (key) { const r3 = await kv(['INCRBY', key, -COST[kd]]); if (r3 < 0) await kv(['SET', key, 0, 'EX', TOK_WIN]); }
            await Promise.all([stat('tok', -COST[kd]), stat('tm:gen-' + kd, -COST[kd]), stat('tf:gen', -COST[kd]), stat('gen_fail_' + kd)]);
          }
        }
      } catch {}
    }
    return J({ ok: true, status: p.status, file: p.status === 'succeeded' ? file : null, error: p.status === 'failed' || p.status === 'canceled' ? String(p.error || 'Gagal dibuat').slice(0, 200) : null });
  }
  return E('Aksi tidak dikenal', 400);
}
