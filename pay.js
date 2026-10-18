// Vercel Edge Function: pembayaran otomatis lewat Midtrans (Snap). Letakkan sebagai api/pay.js
// Env: MIDTRANS_SERVER_KEY (Server Key dari dashboard Midtrans; diawali SB- untuk sandbox), PRO_PLANS (JSON dengan harga angka "a"),
//      KV_REST_API_URL + KV_REST_API_TOKEN (Upstash). Opsional: MIDTRANS_URL (override), ALLOWED_ORIGINS.
// Di dashboard Midtrans: Settings > Payment > Notification URL = https://DOMAIN-KAMU/api/pay
// Contoh PRO_PLANS: [{"d":30,"n":"Pro 30 hari","p":"Rp29.000","a":29000},{"d":365,"n":"Pro 1 tahun","p":"Rp249.000","a":249000}]
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SK = (process.env.MIDTRANS_SERVER_KEY || '').trim();
const SNAP = (process.env.MIDTRANS_URL || (SK.startsWith('SB-') ? 'https://app.sandbox.midtrans.com/snap/v1/transactions' : 'https://app.midtrans.com/snap/v1/transactions')).trim();
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enc = new TextEncoder();

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
const hex = u => [...new Uint8Array(u)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha512 = async s => hex(await crypto.subtle.digest('SHA-512', enc.encode(s)));
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const fmt = n => (n.match(/.{1,4}/g) || []).join('-');
function newCode() { const r = crypto.getRandomValues(new Uint8Array(12)); return 'AURA' + [...r].map(x => B32[x % 32]).join(''); }
function plans() {
  try { return JSON.parse(process.env.PRO_PLANS || '[]').map(x => ({ d: +x.d || 30, n: String(x.n || 'Pro').slice(0, 40), a: Math.round(+x.a) || 0 })).filter(x => x.a >= 1000); } catch { return []; }
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
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st) => J({ error: { message: m } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const enabled = !!(SK && KV_URL && KV_TOKEN && plans().length);
  const u = new URL(req.url);
  if (req.method === 'GET') {
    const o = u.searchParams.get('order');
    if (!o) return J({ enabled });
    if (!ok) return E('Origin tidak diizinkan', 403);
    if (!enabled) return E('Pembayaran otomatis belum diatur', 503);
    if (!/^AUR[0-9A-F]{16}$/.test(o)) return E('Order tidak valid', 400);
    const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
    if (limited('g' + ip, 90)) return E('Terlalu banyak permintaan', 429);
    try {
      const raw = await kv(['GET', 'auralis:ord:' + o]);
      if (!raw) return J({ status: 'none' });
      const ord = JSON.parse(raw);
      return J(ord.st === 'paid' ? { status: 'paid', code: fmt(ord.code) } : { status: ord.st });
    } catch { return E('Penyimpanan tidak bisa dihubungi', 502); }
  }
  if (req.method !== 'POST') return E('Method tidak didukung', 405);
  if (!enabled) return E('Pembayaran otomatis belum diatur', 503);
  let b; try { b = await req.json(); } catch { return E('Body tidak valid', 400); }
  if (!b || typeof b !== 'object') return E('Permintaan tidak valid', 400);

  try {
    // ---- notifikasi dari Midtrans (tanpa cek origin; dilindungi tanda tangan) ----
    if (b.signature_key) {
      const oid = String(b.order_id || '');
      if (!/^AUR[0-9A-F]{16}$/.test(oid)) return J({ ok: true });
      const sig = await sha512(oid + String(b.status_code) + String(b.gross_amount) + SK);
      if (!same(sig, String(b.signature_key))) return E('Tanda tangan tidak valid', 403);
      const key = 'auralis:ord:' + oid, raw = await kv(['GET', key]);
      if (!raw) return J({ ok: true });
      const ord = JSON.parse(raw), ts = String(b.transaction_status || ''), fraud = String(b.fraud_status || 'accept');
      if (Math.round(+b.gross_amount) !== ord.a) return E('Jumlah tidak cocok', 400);
      if ((ts === 'settlement' || (ts === 'capture' && fraud === 'accept')) && ord.st !== 'paid') {
        const code = newCode();
        await kv(['SET', 'auralis:lic:' + code, JSON.stringify({ d: ord.d, max: 3, note: 'otomatis ' + oid, made: Date.now(), devs: [], exp: 0, rev: false })]);
        await kv(['SADD', 'auralis:lic:index', code]);
        ord.st = 'paid'; ord.code = code; ord.paid = Date.now();
        await kv(['SET', key, JSON.stringify(ord)]);
      } else if (['refund', 'partial_refund', 'chargeback'].includes(ts) && ord.code) {
        const lk = 'auralis:lic:' + ord.code, lr = await kv(['GET', lk]);
        if (lr) { const l = JSON.parse(lr); l.rev = true; await kv(['SET', lk, JSON.stringify(l)]); }
        ord.st = 'refunded'; await kv(['SET', key, JSON.stringify(ord)]);
      } else if (['deny', 'cancel', 'expire', 'failure'].includes(ts) && ord.st === 'pending') {
        ord.st = 'failed'; await kv(['SET', key, JSON.stringify(ord)]);
      }
      return J({ ok: true });
    }

    // ---- pembeli membuat transaksi ----
    if (!ok) return E('Origin tidak diizinkan', 403);
    if (b.action !== 'create') return E('Aksi tidak dikenal', 400);
    const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
    if (limited('c' + ip, 10)) return E('Terlalu banyak percobaan. Coba lagi beberapa menit lagi.', 429);
    const pl = plans()[+b.plan];
    if (!pl) return E('Paket tidak ditemukan', 400);
    const oid = 'AUR' + hex(crypto.getRandomValues(new Uint8Array(8))).toUpperCase();
    const r = await fetch(SNAP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Basic ' + btoa(SK + ':') },
      body: JSON.stringify({
        transaction_details: { order_id: oid, gross_amount: pl.a },
        item_details: [{ id: 'pro-' + pl.d, price: pl.a, quantity: 1, name: pl.n.slice(0, 50) }],
        callbacks: { finish: own + '/?bayar=' + oid },
      }),
    });
    if (!r.ok) return E('Midtrans menolak permintaan (' + r.status + ')', 502);
    const j = await r.json();
    if (!j.redirect_url) return E('Midtrans tidak mengembalikan tautan bayar', 502);
    await kv(['SET', 'auralis:ord:' + oid, JSON.stringify({ d: pl.d, a: pl.a, n: pl.n, st: 'pending', made: Date.now() })]);
    return J({ order: oid, url: j.redirect_url });
  } catch {
    return E('Layanan pembayaran tidak bisa dihubungi', 502);
  }
}
