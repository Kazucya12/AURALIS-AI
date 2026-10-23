// Vercel Edge Function: akun Auralis di server, supaya bisa masuk dari perangkat mana pun. Letakkan sebagai api/acct.js
// Env wajib: PRO_SECRET (atau ACCT_SECRET; teks acak panjang), KV_REST_API_URL + KV_REST_API_TOKEN (Upstash).
// Env untuk kode pemulihan lewat email: RESEND_API_KEY + MAIL_FROM. Pengirim onboarding@resend.dev hanya bisa mengirim ke pemilik akun Resend;
//   untuk mengirim ke pengguna mana pun, verifikasi domain sendiri di Resend dan pakai alamat di domain itu.
// Server hanya menyimpan nama, warna, dan hash kata sandi (HMAC dengan rahasia server + garam per akun). Data obrolan tetap di perangkat / sinkron terenkripsi.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SECRET = (process.env.ACCT_SECRET || process.env.PRO_SECRET || '').trim();
const RESEND = (process.env.RESEND_API_KEY || '').trim();
const FROM = (process.env.MAIL_FROM || '').trim();
const MAIL_API = (process.env.RESEND_URL || 'https://api.resend.com/emails').trim();
const TTL = 10 * 60e3, MAX_TRY = 5, MAX_SEND_HOUR = 3, MAX_FAIL = 8;
const enc = new TextEncoder();

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
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const code6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const HEX = /^[0-9a-f]{64}$/;
const pwOf = (salt, ph) => mac('pw|' + salt + '|' + ph);
const akey = async email => 'auralis:acct:' + (await sha(email));

const hits = new Map();

// Statistik harian (Asia/Jakarta): penghitung ringan di Upstash, tersimpan 40 hari. Gagal diam-diam.
const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
async function stat(name, by) { try { const k = 'auralis:st:' + dayKey() + ':' + name, n = await kv(by ? ['INCRBY', k, by] : ['INCR', k]); if (n === (by || 1)) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }

const BAD_MAIL = new Set(('mailinator.com,guerrillamail.com,10minutemail.com,tempmail.com,temp-mail.org,yopmail.com,trashmail.com,throwawaymail.com,sharklasers.com,getnada.com,maildrop.cc,dispostable.com,fakeinbox.com,mintemail.com,moakt.com,emailondeck.com,mohmal.com,tmpmail.org,burnermail.io,discard.email,' + (process.env.BLOCK_EMAIL_DOMAINS || '')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const SIGNUP_DAY = +process.env.SIGNUP_PER_IP_DAY || 5;
function limited(key, LIM) {
  const now = Date.now(), WIN = 10 * 60e3, a = (hits.get(key) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(key, a); return false;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st, code) => J({ error: { message: m, code } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  const enabled = !!(SECRET && KV_URL && KV_TOKEN), mail = !!(enabled && RESEND && FROM);
  if (req.method === 'GET') return J({ enabled, mail });
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!enabled) return E('Akun server belum diatur', 503);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited('ip:' + ip, 30)) return E('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.', 429);

  let d; try { d = await req.json(); } catch { return E('Body tidak valid', 400); }
  const email = String(d.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) return E('Format email belum benar', 400);
  const key = await akey(email);
  const clean = (n, c) => ({ name: String(n || '').trim().slice(0, 40) || 'Pengguna', color: String(c || '').slice(0, 20) });
  const prof = a => ({ name: a.name, color: a.color });

  try {
    // gagal berulang -> kunci sementara per email
    const failKey = 'auralis:af:' + (await sha(email));
    const failed = async () => { const n = await kv(['INCR', failKey]); if (n === 1) await kv(['EXPIRE', failKey, 900]); };
    const locked = async () => (+(await kv(['GET', failKey])) || 0) >= MAX_FAIL;
    const load = async () => { const r = await kv(['GET', key]); return r ? JSON.parse(r) : null; };
    const check = async (a, ph) => a && HEX.test(ph) && same(await pwOf(a.salt, ph), a.pw);

    if (d.action === 'register') {
      const ph = String(d.ph || '');
      if (!HEX.test(ph)) return E('Permintaan tidak valid', 400);
      if (BAD_MAIL.has(email.split('@')[1])) { await stat('blocked'); return E('Email sementara tidak diterima. Pakai email yang kamu gunakan sehari-hari.', 400, 'mail'); }
      const rk = 'auralis:rg:' + (await sha(ip)), rn = await kv(['INCR', rk]);
      if (rn === 1) await kv(['EXPIRE', rk, 86400]);
      if (rn > SIGNUP_DAY) { await stat('blocked'); return E('Terlalu banyak akun baru dari jaringan ini hari ini. Coba lagi besok.', 429, 'ipcap'); }
      const salt = rand(16), a = { email, salt, pw: await pwOf(salt, ph), ...clean(d.name, d.color), t: Date.now() };
      const set = await kv(['SET', key, JSON.stringify(a), 'NX']);
      if (set !== 'OK') return E('Email sudah terdaftar. Silakan masuk.', 409, 'exists');
      await stat('signup');
      return J({ ok: true, profile: prof(a) });
    }

    if (d.action === 'login') {
      if (await locked()) return E('Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.', 429);
      const ph = String(d.ph || ''), a = await load();
      if (a) {
        if (!(await check(a, ph))) { await failed(); return E('Email atau kata sandi salah.', 401, 'bad'); }
        return J({ ok: true, profile: prof(a) });
      }
      // migrasi akun lama yang hanya ada di perangkat: klien sudah memeriksa kata sandi secara lokal
      if (d.create && HEX.test(ph)) {
        const salt = rand(16), n = { email, salt, pw: await pwOf(salt, ph), ...clean(d.name, d.color), t: Date.now() };
        if ((await kv(['SET', key, JSON.stringify(n), 'NX'])) === 'OK') return J({ ok: true, profile: prof(n), created: true });
        await failed(); return E('Email atau kata sandi salah.', 401, 'bad');
      }
      await failed(); return E('Email atau kata sandi salah.', 401, 'bad');
    }

    if (d.action === 'update' || d.action === 'delete') {
      if (await locked()) return E('Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.', 429);
      const a = await load();
      if (!(await check(a, String(d.ph || '')))) { await failed(); return E('Kata sandi salah.', 401, 'bad'); }
      if (d.action === 'delete') { await kv(['DEL', key]); return J({ ok: true }); }
      if (d.name != null) a.name = clean(d.name, '').name;
      if (d.color != null) a.color = String(d.color).slice(0, 20);
      if (d.newph != null) { if (!HEX.test(String(d.newph))) return E('Permintaan tidak valid', 400); a.salt = rand(16); a.pw = await pwOf(a.salt, d.newph); }
      await kv(['SET', key, JSON.stringify(a)]);
      return J({ ok: true, profile: prof(a) });
    }

    if (d.action === 'rsend') {
      if (!mail) return E('Pemulihan lewat email belum diatur di server', 503);
      if (limited('rs:' + ip, 8)) return E('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.', 429);
      const exp = Date.now() + TTL, a = await load();
      if (!a) return J({ ok: true, token: exp + '.' + rand(32), exp }); // jawaban sama agar daftar email tidak bisa ditebak
      const rk = 'auralis:acs:' + (await sha(email)), n = await kv(['INCR', rk]);
      if (n === 1) await kv(['EXPIRE', rk, 3600]);
      if (n > MAX_SEND_HOUR) return E('Terlalu sering meminta kode. Coba lagi dalam satu jam.', 429);
      const code = code6(), token = exp + '.' + (await mac('ac|' + email + '|' + code + '|' + exp));
      let r;
      try {
        r = await fetch(MAIL_API, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: FROM, to: [email], subject: 'Kode pemulihan akun Auralis: ' + code,
            html: '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">Pemulihan akun</h2><p>Masukkan kode ini di Auralis AI untuk membuat kata sandi baru. Berlaku 10 menit.</p><p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:14px 0">' + code + '</p><p style="color:#666">Abaikan email ini bila bukan kamu yang meminta.</p></div>',
            text: 'Kode pemulihan akun Auralis: ' + code + ' (berlaku 10 menit). Abaikan bila bukan kamu yang meminta.',
          }),
        });
      } catch { return E('Email tidak bisa dikirim sekarang', 502); }
      if (!r.ok) return E('Email gagal dikirim. Periksa pengaturan pengirim di server.', 502);
      return J({ ok: true, token, exp });
    }

    if (d.action === 'reset') {
      const c = String(d.code || '').trim(), token = String(d.token || ''), exp = +d.exp, ph = String(d.ph || '');
      if (!/^\d{6}$/.test(c) || !exp || Date.now() > exp || !HEX.test(ph)) return E('Kode salah atau kedaluwarsa', 400);
      const th = await sha(token);
      if (await kv(['GET', 'auralis:acu:' + th])) return E('Kode sudah dipakai', 400);
      const ak = 'auralis:aca:' + th, n = await kv(['INCR', ak]);
      if (n === 1) await kv(['EXPIRE', ak, 700]);
      if (n > MAX_TRY) return E('Terlalu banyak percobaan. Minta kode baru.', 429);
      const want = exp + '.' + (await mac('ac|' + email + '|' + c + '|' + exp));
      const a = await load();
      if (!a || !same(want, token)) return E('Kode salah atau kedaluwarsa', 400);
      await kv(['SET', 'auralis:acu:' + th, '1', 'EX', 700]);
      a.salt = rand(16); a.pw = await pwOf(a.salt, ph);
      await kv(['SET', key, JSON.stringify(a)]); await kv(['DEL', failKey]);
      return J({ ok: true, profile: prof(a) });
    }
    return E('Aksi tidak dikenal', 400);
  } catch { return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
}
