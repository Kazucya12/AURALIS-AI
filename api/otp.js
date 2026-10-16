// Vercel Node Function: kode verifikasi email (OTP) lewat Gmail pribadi (SMTP + App Password).
// Stateless: kode ditandatangani HMAC dengan AUTH_SECRET, tanpa database.
// Env: GMAIL_USER, GMAIL_APP_PASSWORD, AUTH_SECRET, MAIL_FROM_NAME (opsional)
// Butuh dependency "nodemailer" di package.json.
import nodemailer from 'nodemailer';
import { createHmac, timingSafeEqual, randomInt } from 'crypto';

const hits = new Map();
function limited(key, max) {
  const now = Date.now(), WIN = 10 * 60e3;
  const a = (hits.get(key) || []).filter(t => now - t < WIN);
  if (a.length >= max) return true;
  a.push(now); hits.set(key, a);
  return false;
}
const sign = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function handler(req, res) {
  const secret = (process.env.AUTH_SECRET || '').trim();
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const enabled = !!(secret && user && pass);
  const out = (st, o) => { res.setHeader('cache-control', 'no-store'); res.status(st).json(o); };

  if (req.method === 'GET') return out(200, { enabled });
  if (req.method !== 'POST') return out(405, { error: 'Method tidak didukung' });
  if (!enabled) return out(503, { error: 'Verifikasi email belum dikonfigurasi di server' });

  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return out(403, { error: 'Origin tidak diizinkan' }); } catch { return out(403, { error: 'Origin tidak valid' }); } }

  let d = req.body;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
  if (!d || typeof d !== 'object') return out(400, { error: 'Body tidak valid' });

  const email = String(d.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) return out(400, { error: 'Format email tidak valid' });
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();

  if (d.action === 'send') {
    if (limited('ip:' + ip, 5) || limited('em:' + email, 3)) return out(429, { error: 'Terlalu banyak permintaan kode. Coba lagi beberapa menit lagi.' });
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const exp = Date.now() + 10 * 60e3;
    const token = sign(secret, `${email}|${code}|${exp}`);
    const name = (process.env.MAIL_FROM_NAME || 'Auralis AI').trim();
    try {
      const tr = nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, connectionTimeout: 8000, socketTimeout: 10000 });
      await tr.sendMail({
        from: `"${name}" <${user}>`,
        to: email,
        subject: `Kode verifikasi ${name}: ${code}`,
        text: `Kode verifikasi ${name} kamu: ${code}\n\nKode berlaku 10 menit. Jika bukan kamu yang mendaftar, abaikan email ini.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e5e2f5;border-radius:14px"><h2 style="margin:0 0 8px;color:#4b3fd6">${name}</h2><p>Gunakan kode berikut untuk menyelesaikan pendaftaran:</p><p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p><p style="color:#666;font-size:13px">Kode berlaku 10 menit. Jika bukan kamu yang mendaftar, abaikan email ini.</p></div>`,
      });
    } catch { return out(502, { error: 'Gagal mengirim email. Cek GMAIL_USER dan GMAIL_APP_PASSWORD di server.' }); }
    return out(200, { token, exp });
  }

  if (d.action === 'verify') {
    if (limited('v:' + ip, 15)) return out(429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    const code = String(d.code || '').trim(), exp = +d.exp, token = String(d.token || '');
    if (!/^\d{6}$/.test(code) || !exp) return out(400, { error: 'Kode tidak valid' });
    if (Date.now() > exp) return out(400, { error: 'Kode sudah kedaluwarsa. Kirim ulang kode.' });
    return same(sign(secret, `${email}|${code}|${exp}`), token) ? out(200, { ok: true }) : out(400, { error: 'Kode salah.' });
  }
  return out(400, { error: 'Aksi tidak dikenal' });
}
