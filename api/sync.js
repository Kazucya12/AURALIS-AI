// Vercel Edge Function: penyimpanan sinkron terenkripsi. Letakkan sebagai api/sync.js
// Server hanya menyimpan data acak (sudah dienkripsi di perangkat), jadi tidak bisa membaca isi obrolan.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel > Storage > Upstash Redis),
//      atau UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. Opsional: SYNC_MAX_BYTES, SYNC_RATE_LIMIT.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const MAX = +process.env.SYNC_MAX_BYTES || 900000;
const CH = 700000, TOP = 4000000; // potongan per kunci (batas permintaan Upstash) dan batas atas (batas isi permintaan Vercel)
const HEX = /^[0-9a-f]{64}$/;

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}

async function sha256(s) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}


// --- Pro: verifikasi token lisensi (PRO_SECRET). Bila PRO_SECRET kosong, sistem Pro nonaktif dan semua fitur terbuka. ---
const PRO_SECRET = (process.env.PRO_SECRET || '').trim();
const _enc = new TextEncoder();
const _unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function licInfo(req) {
  if (!PRO_SECRET) return null;
  const t = req.headers.get('x-license') || '';
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  try {
    const k = await crypto.subtle.importKey('raw', _enc.encode(PRO_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', k, _unb64u(sig), _enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(_unb64u(body)));
    return p.p === 'pro' && p.e > Date.now() ? p : null;
  } catch { return null; }
}
async function isPro(req) { return !PRO_SECRET || !!(await licInfo(req)); }
const PRO_ERR = { error: { message: 'Fitur ini khusus Pro. Buka menu Atur > Langganan untuk upgrade.', code: 'pro_required' } };

const hits = new Map();
function limited(ip) {
  const now = Date.now(), LIM = +process.env.SYNC_RATE_LIMIT || 60, WIN = 10 * 60e3;
  const a = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(ip, a);
  return false;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = {
    'access-control-allow-origin': ok && origin ? origin : own,
    'access-control-allow-headers': 'content-type,x-license',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    vary: 'origin',
  };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st, x) => J({ error: { message: m }, ...x }, st);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);

  const u = new URL(req.url);
  const enabled = !!(KV_URL && KV_TOKEN);

  if (req.method === 'GET' && !u.searchParams.get('id')) return J({ enabled });
  if (!enabled) return E('Penyimpanan sinkron belum diatur di server', 503);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited(ip)) return E('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.', 429);

  try {
    if (req.method === 'GET') {
      const id = u.searchParams.get('id');
      if (!HEX.test(id)) return E('ID tidak valid', 400);
      const raw = await kv(['GET', 'auralis:sync:' + id]);
      if (!raw) return J({ v: 0 });
      const rec = JSON.parse(raw);
      if (rec.n) {
        const parts = await kv(['MGET', ...Array.from({ length: rec.n }, (_, i) => 'auralis:sync:' + id + ':' + i)]);
        if (!parts || parts.some(x => typeof x !== 'string')) return E('Data sinkron rusak, unggah ulang dari perangkat utama', 500);
        return J({ v: rec.v, d: parts.join(''), t: rec.t });
      }
      return J({ v: rec.v, d: rec.d, t: rec.t });
    }

    if (req.method !== 'DELETE' && !(await isPro(req))) return J(PRO_ERR, 402);
    const lic = await licInfo(req), limit = Math.min(Math.max(lic && lic.q ? lic.q : MAX, MAX), TOP);
    if (+req.headers.get('content-length') > limit + 4000) return E('Data terlalu besar untuk kuota penyimpanan kamu (' + Math.round(limit / 1000) + ' KB)', 413);
    let b; try { b = await req.json(); } catch { return E('Body tidak valid', 400); }
    if (!b || !HEX.test(b.id) || !HEX.test(b.ws)) return E('Permintaan tidak valid', 400);
    const key = 'auralis:sync:' + b.id;
    const wh = await sha256(b.ws);
    const raw = await kv(['GET', key]);
    const cur = raw ? JSON.parse(raw) : null;
    if (cur && cur.wh !== wh) return E('Kunci tulis salah', 403);

    if (req.method === 'DELETE') {
      if (cur) { await kv(['DEL', key]); if (cur.n) for (let i = 0; i < cur.n; i++) await kv(['DEL', key + ':' + i]); }
      return J({ ok: true });
    }

    if (req.method !== 'POST') return E('Method tidak didukung', 405);
    if (typeof b.d !== 'string' || !b.d || b.d.length > limit) return E('Data terlalu besar untuk kuota penyimpanan kamu (' + Math.round(limit / 1000) + ' KB). Hapus obrolan lama atau minta penjual menambah penyimpanan.', 413);
    if (!Number.isInteger(b.v) || b.v < 0) return E('Versi tidak valid', 400);
    if ((cur ? cur.v : 0) !== b.v) return E('Versi sudah berubah, sinkron ulang', 409, { v: cur ? cur.v : 0 });
    const rec = { v: b.v + 1, t: Date.now(), wh };
    const n = b.d.length > CH ? Math.ceil(b.d.length / CH) : 0;
    if (n) { for (let i = 0; i < n; i++) await kv(['SET', key + ':' + i, b.d.slice(i * CH, (i + 1) * CH)]); rec.n = n; } else rec.d = b.d;
    await kv(['SET', key, JSON.stringify(rec)]);
    if (cur && cur.n) for (let i = n; i < cur.n; i++) await kv(['DEL', key + ':' + i]);
    return J({ v: rec.v, t: rec.t });
  } catch {
    return E('Penyimpanan tidak bisa dihubungi', 502);
  }
}
