// Vercel Edge Function: langganan Pro dan Max (kode lisensi). Letakkan sebagai api/pro.js
// Env wajib: PRO_SECRET (teks acak panjang, untuk tanda tangan token), PRO_ADMIN_KEY (opsional, kata sandi cadangan; admin utama masuk lewat kode email, lihat api/admin.js),
//            KV_REST_API_URL + KV_REST_API_TOKEN (Upstash, sama seperti sinkron).
// Env tampilan: PRO_PAY_URL (tautan bayar: Saweria/Trakteer/Lynk/Midtrans/dll), PRO_CONTACT (mis. https://wa.me/62812xxxx untuk kirim bukti bayar),
//               PRO_PLANS (opsional, JSON): [{"d":30,"n":"Pro 30 hari","p":"Rp35.000","t":"pro"},{"d":30,"n":"Max 30 hari","p":"Rp75.000","t":"max"}]
//               Field "t" ("pro" atau "max") menentukan paket. Tanpa "t", paket dianggap Max bila namanya memuat kata "Max", selain itu Pro.
// Paket: lisensi punya field pl ("pro" atau "max"). Token yang ditandatangani memuat p:"pro" atau p:"max".
//        Max otomatis mendapat penyimpanan sinkron MAX_Q (3 MB) bila q tidak diisi. api/gen.js dan api/chat.js harus mengenali p:"max".
// Opsional: PRO_MAX_DEVICES (bawaan 3), ALLOWED_ORIGINS.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SECRET = (process.env.PRO_SECRET || '').trim();
const ADMIN = (process.env.PRO_ADMIN_KEY || '').trim();
const TOKEN_DAYS = 7;
const MAX_Q = 3e6;
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
const planOf = x => (x && (x.t === 'max' || /\bmax\b/i.test(String(x.n || '')))) ? 'max' : 'pro';

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

const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
async function stat(name) { try { const k = 'auralis:st:' + dayKey() + ':' + name, n = await kv(['INCR', k]); if (n === 1) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const TRIAL_DAYS = process.env.TRIAL_DAYS === undefined || process.env.TRIAL_DAYS === '' ? 1 : Math.min(Math.max(+process.env.TRIAL_DAYS || 0, 0), 14);
const REF_BONUS = Math.min(Math.max(process.env.TRIAL_REF_BONUS === undefined ? 1 : +process.env.TRIAL_REF_BONUS || 0, 0), 7);
const REF_DAYS = Math.min(Math.max(+process.env.REF_REWARD_DAYS || 2, 1), 30), REF_MAX = 10;
const RC = /^[A-Za-z0-9]{8,16}$/;
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
    try { plans = JSON.parse(process.env.PRO_PLANS || '[]').slice(0, 4).map(x => ({ d: +x.d || 30, n: String(x.n || 'Pro').slice(0, 40), p: String(x.p || '').slice(0, 30), t: planOf(x) })); } catch { plans = []; }
    let auto = false; try { auto = !!(process.env.MIDTRANS_SERVER_KEY || '').trim() && JSON.parse(process.env.PRO_PLANS || '[]').some(x => +x.a >= 1000); } catch { auto = false; }
    return J({ enabled, trial: enabled && TRIAL_DAYS > 0, trialDays: TRIAL_DAYS, refDays: REF_DAYS, refBonus: REF_BONUS, auto, payUrl: /^https?:\/\//i.test(process.env.PRO_PAY_URL || '') ? process.env.PRO_PAY_URL.trim() : '', contact: /^https?:\/\//i.test(process.env.PRO_CONTACT || '') ? process.env.PRO_CONTACT.trim() : '', plans });
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
      const pl = lic.pl === 'max' ? 'max' : 'pro', q = lic.q || (pl === 'max' ? MAX_Q : 0);
      return J({ ok: true, pl, q, token: await sign({ p: pl, e: te, c: code.slice(4, 12), q }), te, exp: lic.exp });
    }

    // Lisensi pendek (trial / hadiah referral): satu perangkat, tanpa penyimpanan ekstra, selalu paket Pro
    const mini = async (days, note, dev) => {
      const now = Date.now(), c = newCode(), exp = now + days * 864e5;
      await kv(['SET', 'auralis:lic:' + c, JSON.stringify({ d: days, max: 1, note, q: 0, pl: 'pro', made: now, act: now, devs: [dev], exp, rev: false })]);
      await kv(['SADD', 'auralis:lic:index', c]);
      const te = Math.min(exp, now + TOKEN_DAYS * 864e5);
      return { ok: true, pl: 'pro', q: 0, token: await sign({ p: 'pro', e: te, c: c.slice(4, 12), q: 0 }), te, exp, code: fmt(c) };
    };
    if (b.action === 'trial') {
      if (!TRIAL_DAYS) return E('Trial gratis sedang tidak tersedia.', 403);
      if (limited('t' + ip, 6)) return E('Terlalu banyak percobaan. Coba lagi nanti.', 429);
      const dev = String(b.dev || '').slice(0, 40);
      if (!dev) return E('Permintaan tidak valid', 400);
      const okIp = await kv(['SET', 'auralis:trial:i:' + (await sha(ip)), '1', 'NX', 'EX', 30 * 86400]);
      if (okIp !== 'OK') { await stat('trial_denied'); return E('Trial gratis sudah pernah dipakai dari jaringan ini.', 403); }
      const okDev = await kv(['SET', 'auralis:trial:d:' + (await sha(dev)), '1', 'NX', 'EX', 30 * 86400]);
      if (okDev !== 'OK') { await stat('trial_denied'); return E('Trial gratis sudah pernah dipakai di perangkat ini.', 403); }
      const ref = RC.test(String(b.ref || '')) && String(b.ref) !== String(b.rc || '') ? String(b.ref) : '';
      let days = TRIAL_DAYS;
      if (ref && REF_BONUS) { days += REF_BONUS; await kv(['INCR', 'auralis:ref:' + ref]); await stat('ref'); }
      await stat('trial');
      return J(await mini(days, ref ? 'trial+ref' : 'trial', dev));
    }
    if (b.action === 'refinfo' || b.action === 'refclaim') {
      const rc = String(b.rc || ''), dev = String(b.dev || '').slice(0, 40);
      if (!RC.test(rc)) return E('Permintaan tidak valid', 400);
      const n = Math.min(+(await kv(['GET', 'auralis:ref:' + rc])) || 0, REF_MAX), got = +(await kv(['GET', 'auralis:refc:' + rc])) || 0, left = Math.max(n - got, 0);
      if (b.action === 'refinfo') return J({ ok: true, invited: n, claimed: got, left, max: REF_MAX, days: REF_DAYS });
      if (limited('rc' + ip, 6)) return E('Terlalu banyak percobaan. Coba lagi nanti.', 429);
      if (!left || !dev) return E('Belum ada undangan yang bisa diklaim.', 400);
      if ((await kv(['INCR', 'auralis:refc:' + rc])) > n) { await kv(['DECR', 'auralis:refc:' + rc]); return E('Belum ada undangan yang bisa diklaim.', 400); }
      await stat('ref_claim');
      return J({ ...(await mini(REF_DAYS, 'hadiah referral', dev)), left: left - 1 });
    }

    // ---- penjual ----
    if (limited('a' + ip, 40)) return E('Terlalu banyak permintaan', 429);
    if (!(await adminOk(req))) return E('Akses admin ditolak. Masuk lewat panel admin.', 403);
    if (b.action === 'create') {
      const days = Math.min(Math.max(+b.days || 30, 1), 3650), count = Math.min(Math.max(+b.count || 1, 1), 20), max = Math.min(Math.max(+b.max || 3, 1), 10), note = String(b.note || '').slice(0, 60);
      const pl = b.pl === 'max' ? 'max' : 'pro', q = [2, 3, 4].includes(+b.q) ? +b.q * 1e6 : (pl === 'max' ? MAX_Q : 0);
      const out = [];
      for (let i = 0; i < count; i++) {
        const c = newCode();
        await kv(['SET', 'auralis:lic:' + c, JSON.stringify({ d: days, max, note, q, pl, made: Date.now(), devs: [], exp: 0, rev: false })]);
        await kv(['SADD', 'auralis:lic:index', c]);
        out.push(fmt(c));
      }
      return J({ ok: true, codes: out, days, pl });
    }
    if (b.action === 'list') {
      const ids = ((await kv(['SMEMBERS', 'auralis:lic:index'])) || []).slice(-300), rows = [];
      for (const c of ids) {
        const raw = await kv(['GET', 'auralis:lic:' + c]); if (!raw) continue;
        const l = JSON.parse(raw);
        rows.push({ code: fmt(c), pl: l.pl === 'max' ? 'max' : 'pro', q: l.q || 0, d: l.d, note: l.note || '', made: l.made || 0, act: l.act || 0, exp: l.exp || 0, devs: (l.devs || []).length, max: l.max || 3, rev: !!l.rev });
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
    if (['extend', 'restore', 'reset', 'delete', 'note', 'storage', 'plan'].includes(b.action)) {
      const code = norm(b.code), key = 'auralis:lic:' + code, raw = await kv(['GET', key]);
      if (!raw) return E('Kode tidak ditemukan', 404);
      const l = JSON.parse(raw), now = Date.now();
      if (b.action === 'delete') { await kv(['DEL', key]); await kv(['SREM', 'auralis:lic:index', code]); return J({ ok: true }); }
      if (b.action === 'restore') l.rev = false;
      if (b.action === 'reset') l.devs = [];
      if (b.action === 'storage') l.q = [2, 3, 4].includes(+b.q) ? +b.q * 1e6 : 0;
      if (b.action === 'plan') { l.pl = b.pl === 'max' ? 'max' : 'pro'; if (l.pl === 'max' && !l.q) l.q = MAX_Q; }
      if (b.action === 'note') l.note = String(b.note || '').slice(0, 60);
      if (b.action === 'extend') {
        const days = Math.min(Math.max(Math.round(+b.days) || 0, 1), 3650);
        if (l.exp) l.exp = Math.max(l.exp, now) + days * 864e5; else l.d = (l.d || 0) + days;
      }
      await kv(['SET', key, JSON.stringify(l)]);
      return J({ ok: true, exp: l.exp || 0, d: l.d, pl: l.pl === 'max' ? 'max' : 'pro' });
    }
    return E('Aksi tidak dikenal', 400);
  } catch {
    return E('Penyimpanan tidak bisa dihubungi', 502);
  }
}
