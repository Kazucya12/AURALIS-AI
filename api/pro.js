// Vercel Edge Function: langganan Pro (kode lisensi). Letakkan sebagai api/pro.js
// Env wajib: PRO_SECRET (teks acak panjang, untuk tanda tangan token), PRO_ADMIN_KEY (opsional, kata sandi cadangan; admin utama masuk lewat kode email, lihat api/admin.js),
//            KV_REST_API_URL + KV_REST_API_TOKEN (Upstash, sama seperti sinkron).
// Env tampilan: PRO_PAY_URL (tautan bayar: Saweria/Trakteer/Lynk/Midtrans/dll), PRO_CONTACT (mis. https://wa.me/62812xxxx untuk kirim bukti bayar),
//               PRO_PLANS (opsional, JSON: [{"d":30,"n":"Pro 30 hari","p":"Rp29.000"},{"d":365,"n":"Pro 1 tahun","p":"Rp249.000"}]).
// Opsional: PRO_MAX_DEVICES (bawaan 3), ALLOWED_ORIGINS.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SECRET = (process.env.PRO_SECRET || '').trim();
const ADMIN = (process.env.PRO_ADMIN_KEY || '').trim();
const TOKEN_DAYS = 7;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enc = new TextEncoder();

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
const b64u = u => btoa(String.fromCharCode(...new Uint8Array(u))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const k = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', k, enc.encode(body)));
}
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
const fmt = n => (n.match(/.{1,4}/g) || []).join('-');
function newCode() { const r = crypto.getRandomValues(new Uint8Array(12)); return 'AURA' + [...r].map(x => B32[x % 32]).join(''); }

// Admin: sesi dari api/admin.js (verifikasi kode email), atau kata sandi lama PRO_ADMIN_KEY bila masih diisi (opsional, boleh dihapus).
async function adminOk(req) {
  const k = String(req.headers.get('x-admin') || '');
  if (ADMIN && k && same(k, ADMIN)) return true;
  const s = String(req.headers.get('x-admin-session') || '');
  if (!/^[0-9a-f]{64}$/.test(s)) return false;
  try {
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return !!(await kv(['GET', 'auralis:adm:' + h]));
  } catch { return false; }
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
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-admin,x-admin-session', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st) => J({ error: { message: m } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);

  const enabled = !!(SECRET && KV_URL && KV_TOKEN);
  if (req.method === 'GET') {
    let plans = [];
    try { plans = JSON.parse(process.env.PRO_PLANS || '[]').slice(0, 4).map(x => ({ d: +x.d || 30, n: String(x.n || 'Pro').slice(0, 40), p: String(x.p || '').slice(0, 30) })); } catch { plans = []; }
    let auto = false; try { auto = !!(process.env.MIDTRANS_SERVER_KEY || '').trim() && JSON.parse(process.env.PRO_PLANS || '[]').some(x => +x.a >= 1000); } catch { auto = false; }
    return J({ enabled, auto, payUrl: /^https?:\/\//i.test(process.env.PRO_PAY_URL || '') ? process.env.PRO_PAY_URL.trim() : '', contact: /^https?:\/\//i.test(process.env.PRO_CONTACT || '') ? process.env.PRO_CONTACT.trim() : '', plans });
  }
  if (req.method !== 'POST') return E('Method tidak didukung', 405);
  if (!enabled) return E('Langganan Pro belum diatur di server', 503);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  let b; try { b = await req.json(); } catch { return E('Body tidak valid', 400); }
  if (!b || typeof b.action !== 'string') return E('Permintaan tidak valid', 400);

  try {
    if (b.action === 'redeem') {
      if (limited('r' + ip, 12)) return E('Terlalu banyak percobaan. Coba lagi beberapa menit lagi.', 429);
      const code = norm(b.code), dev = String(b.dev || '').slice(0, 40);
      if (code.length !== 16 || !code.startsWith('AURA') || !dev) return E('Kode tidak valid. Periksa penulisannya.', 400);
      const key = 'auralis:lic:' + code, raw = await kv(['GET', key]);
      if (!raw) return E('Kode tidak ditemukan.', 404);
      const lic = JSON.parse(raw), now = Date.now();
      if (lic.rev) return E('Kode ini sudah dicabut.', 403);
      if (!lic.exp) { lic.act = now; lic.exp = now + lic.d * 864e5; }
      if (lic.exp < now) return E('Kode sudah kedaluwarsa.', 410);
      lic.devs = lic.devs || [];
      const maxDev = lic.max || +process.env.PRO_MAX_DEVICES || 3;
      if (!lic.devs.includes(dev)) {
        if (lic.devs.length >= maxDev) return E('Kode ini sudah dipakai di ' + maxDev + ' perangkat (batas maksimal).', 403);
        lic.devs.push(dev);
      }
      await kv(['SET', key, JSON.stringify(lic)]);
      const te = Math.min(lic.exp, now + TOKEN_DAYS * 864e5);
      return J({ ok: true, token: await sign({ p: 'pro', e: te, c: code.slice(4, 12) }), te, exp: lic.exp });
    }

    // ---- penjual ----
    if (limited('a' + ip, 40)) return E('Terlalu banyak permintaan', 429);
    if (!(await adminOk(req))) return E('Akses admin ditolak. Masuk lewat panel admin.', 403);
    if (b.action === 'create') {
      const days = Math.min(Math.max(+b.days || 30, 1), 3650), count = Math.min(Math.max(+b.count || 1, 1), 20), max = Math.min(Math.max(+b.max || 3, 1), 10), note = String(b.note || '').slice(0, 60);
      const out = [];
      for (let i = 0; i < count; i++) {
        const c = newCode();
        await kv(['SET', 'auralis:lic:' + c, JSON.stringify({ d: days, max, note, made: Date.now(), devs: [], exp: 0, rev: false })]);
        await kv(['SADD', 'auralis:lic:index', c]);
        out.push(fmt(c));
      }
      return J({ ok: true, codes: out, days });
    }
    if (b.action === 'list') {
      const ids = ((await kv(['SMEMBERS', 'auralis:lic:index'])) || []).slice(-300), rows = [];
      for (const c of ids) {
        const raw = await kv(['GET', 'auralis:lic:' + c]); if (!raw) continue;
        const l = JSON.parse(raw);
        rows.push({ code: fmt(c), d: l.d, note: l.note || '', made: l.made || 0, act: l.act || 0, exp: l.exp || 0, devs: (l.devs || []).length, max: l.max || 3, rev: !!l.rev });
      }
      rows.sort((a, c) => c.made - a.made);
      return J({ ok: true, rows });
    }
    if (b.action === 'revoke') {
      const code = norm(b.code), key = 'auralis:lic:' + code, raw = await kv(['GET', key]);
      if (!raw) return E('Kode tidak ditemukan', 404);
      const l = JSON.parse(raw); l.rev = true; await kv(['SET', key, JSON.stringify(l)]);
      return J({ ok: true });
    }
    if (['extend', 'restore', 'reset', 'delete', 'note'].includes(b.action)) {
      const code = norm(b.code), key = 'auralis:lic:' + code, raw = await kv(['GET', key]);
      if (!raw) return E('Kode tidak ditemukan', 404);
      const l = JSON.parse(raw), now = Date.now();
      if (b.action === 'delete') { await kv(['DEL', key]); await kv(['SREM', 'auralis:lic:index', code]); return J({ ok: true }); }
      if (b.action === 'restore') l.rev = false;
      if (b.action === 'reset') l.devs = [];
      if (b.action === 'note') l.note = String(b.note || '').slice(0, 60);
      if (b.action === 'extend') {
        const days = Math.min(Math.max(Math.round(+b.days) || 0, 1), 3650);
        if (l.exp) l.exp = Math.max(l.exp, now) + days * 864e5; else l.d = (l.d || 0) + days;
      }
      await kv(['SET', key, JSON.stringify(l)]);
      return J({ ok: true, exp: l.exp || 0, d: l.d });
    }
    return E('Aksi tidak dikenal', 400);
  } catch {
    return E('Penyimpanan tidak bisa dihubungi', 502);
  }
}
