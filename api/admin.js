// Vercel Edge Function: login admin lewat kode 6 digit yang dikirim ke email admin. Letakkan sebagai api/admin.js
// Hanya SATU email yang bisa menjadi admin: ADMIN_EMAIL (bawaan akbarzenito@gmail.com). Dicek di server, bukan di tampilan.
// Env wajib: RESEND_API_KEY + MAIL_FROM (kirim kode), PRO_SECRET (tanda tangan kode), KV_REST_API_URL + KV_REST_API_TOKEN (sesi).
// Env opsional: ADMIN_EMAIL, ALLOWED_ORIGINS.
// Sesi admin berlaku 6 jam dan dipakai api/pro.js lewat header x-admin-session.
// BARU: action cfg_get / cfg_set menyimpan pengaturan token di KV (kunci auralis:cfg), hanya untuk sesi admin yang sah.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SECRET = (process.env.PRO_SECRET || '').trim();
const RESEND = (process.env.RESEND_API_KEY || '').trim();
const FROM = (process.env.MAIL_FROM || '').trim();
const MAIL_API = (process.env.RESEND_URL || 'https://api.resend.com/emails').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'akbarzenito@gmail.com').trim().toLowerCase();
const TTL = 10 * 60e3, MAX_TRY = 5, MAX_SEND_HOUR = 5, SESSION = 6 * 3600;
const enc = new TextEncoder();
// kolom pengaturan yang boleh disimpan beserta batasnya
const CFG_KEYS = { tokFree: [0, 1e7], tokPro: [0, 1e7], winH: [1, 72], imgTok: [0, 1e5], editTok: [0, 1e5], imgDaily: [0, 1000], editDaily: [0, 1000], capImg: [0, 1e5], capEdit: [0, 1e5] };

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function mac(s) {
  const k = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(s)));
}
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const code6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sessOk(req) {
  const s = String(req.headers.get('x-admin-session') || '');
  if (!/^[0-9a-f]{64}$/.test(s)) return false;
  try { return !!(await kv(['GET', 'auralis:adm:' + (await sha(s))])); } catch { return false; }
}

const hits = new Map();
function limited(key, LIM) {
  const now = Date.now(), WIN = 10 * 60e3, a = (hits.get(key) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(key, a); return false;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-admin-session', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st) => J({ error: { message: m } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  const enabled = !!(RESEND && FROM && SECRET && KV_URL && KV_TOKEN);
  if (req.method === 'GET') return J({ enabled });
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!enabled) return E('Login admin belum diatur di server (RESEND_API_KEY, MAIL_FROM, PRO_SECRET, Upstash)', 503);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited('ip:' + ip, 12)) return E('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.', 429);

  let d; try { d = await req.json(); } catch { return E('Body tidak valid', 400); }

  if (d.action === 'cfg_get' || d.action === 'cfg_set') {
    if (!(await sessOk(req))) return E('Sesi tidak valid', 401);
    try {
      if (d.action === 'cfg_get') { const raw = await kv(['GET', 'auralis:cfg']); return J({ ok: true, cfg: raw ? JSON.parse(raw) : {} }); }
      const clean = {};
      for (const [k, [lo, hi]] of Object.entries(CFG_KEYS)) {
        const v = d.cfg && d.cfg[k];
        if (v === undefined || v === null || v === '') continue;
        const n = Math.round(+v);
        if (!Number.isFinite(n) || n < lo || n > hi) return E(`Nilai ${k} harus antara ${lo} dan ${hi}`, 400);
        clean[k] = n;
      }
      if (Object.keys(clean).length) await kv(['SET', 'auralis:cfg', JSON.stringify(clean)]); else await kv(['DEL', 'auralis:cfg']);
      return J({ ok: true, cfg: clean });
    } catch { return E('Penyimpanan sementara bermasalah', 503); }
  }

  if (d.action === 'check' || d.action === 'logout') {
    const s = String(req.headers.get('x-admin-session') || '');
    if (!/^[0-9a-f]{64}$/.test(s)) return E('Sesi tidak valid', 401);
    const key = 'auralis:adm:' + (await sha(s));
    try {
      if (d.action === 'logout') { await kv(['DEL', key]); return J({ ok: true }); }
      return (await kv(['GET', key])) ? J({ ok: true }) : E('Sesi berakhir', 401);
    } catch { return E('Penyimpanan sementara bermasalah', 503); }
  }

  const email = String(d.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) return E('Format email belum benar', 400);
  const isAdmin = email === ADMIN_EMAIL;

  if (d.action === 'send') {
    const exp = Date.now() + TTL;
    if (!isAdmin) return J({ ok: true, token: exp + '.' + rand(32), exp }); // jawaban sama agar email admin tidak bisa ditebak
    try {
      const key = 'auralis:ads';
      const n = await kv(['INCR', key]);
      if (n === 1) await kv(['EXPIRE', key, 3600]);
      if (n > MAX_SEND_HOUR) return E('Terlalu sering meminta kode. Coba lagi dalam satu jam.', 429);
    } catch { return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
    const code = code6();
    const token = exp + '.' + (await mac('ad|' + email + '|' + code + '|' + exp));
    let r;
    try {
      r = await fetch(MAIL_API, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RESEND },
        body: JSON.stringify({
          from: FROM, to: [email], subject: 'Kode masuk admin Auralis: ' + code,
          html: '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">Masuk admin</h2><p>Masukkan kode ini di panel admin Auralis. Berlaku 10 menit.</p><p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:14px 0">' + code + '</p><p style="color:#666">Abaikan email ini bila bukan kamu yang meminta.</p></div>',
          text: 'Kode masuk admin Auralis: ' + code + ' (berlaku 10 menit). Abaikan bila bukan kamu yang meminta.',
        }),
      });
    } catch { return E('Email tidak bisa dikirim sekarang', 502); }
    if (!r.ok) return E('Email gagal dikirim. Periksa pengaturan pengirim di server.', 502);
    return J({ ok: true, token, exp });
  }

  if (d.action === 'verify') {
    const code = String(d.code || '').trim(), token = String(d.token || ''), exp = +d.exp;
    if (!/^\d{6}$/.test(code) || !exp || Date.now() > exp || !isAdmin) return E('Kode salah atau kedaluwarsa', 400);
    try {
      const th = await sha(token);
      if (await kv(['GET', 'auralis:adu:' + th])) return E('Kode sudah dipakai', 400);
      const key = 'auralis:ada:' + th;
      const n = await kv(['INCR', key]);
      if (n === 1) await kv(['EXPIRE', key, 700]);
      if (n > MAX_TRY) return E('Terlalu banyak percobaan. Minta kode baru.', 429);
      const want = exp + '.' + (await mac('ad|' + email + '|' + code + '|' + exp));
      if (!same(want, token)) return E('Kode salah atau kedaluwarsa', 400);
      await kv(['SET', 'auralis:adu:' + th, '1', 'EX', 700]);
      const session = rand(32);
      await kv(['SET', 'auralis:adm:' + (await sha(session)), '1', 'EX', SESSION]);
      return J({ ok: true, session, ttl: SESSION });
    } catch { return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
  }
  return E('Aksi tidak dikenal', 400);
}
