// Vercel Edge Function: penyimpanan sinkron terenkripsi. Letakkan sebagai api/sync.js
// Server hanya menyimpan data acak (sudah dienkripsi di perangkat), jadi tidak bisa membaca isi obrolan.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel > Storage > Upstash Redis),
//      atau UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. Opsional: SYNC_MAX_BYTES, SYNC_RATE_LIMIT.
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const MAX = +process.env.SYNC_MAX_BYTES || 900000;
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
    'access-control-allow-headers': 'content-type',
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
      return J({ v: rec.v, d: rec.d, t: rec.t });
    }

    if (+req.headers.get('content-length') > MAX + 4000) return E('Data terlalu besar', 413);
    let b; try { b = await req.json(); } catch { return E('Body tidak valid', 400); }
    if (!b || !HEX.test(b.id) || !HEX.test(b.ws)) return E('Permintaan tidak valid', 400);
    const key = 'auralis:sync:' + b.id;
    const wh = await sha256(b.ws);
    const raw = await kv(['GET', key]);
    const cur = raw ? JSON.parse(raw) : null;
    if (cur && cur.wh !== wh) return E('Kunci tulis salah', 403);

    if (req.method === 'DELETE') {
      if (cur) await kv(['DEL', key]);
      return J({ ok: true });
    }

    if (req.method !== 'POST') return E('Method tidak didukung', 405);
    if (typeof b.d !== 'string' || !b.d || b.d.length > MAX) return E('Data terlalu besar atau kosong', 413);
    if (!Number.isInteger(b.v) || b.v < 0) return E('Versi tidak valid', 400);
    if ((cur ? cur.v : 0) !== b.v) return E('Versi sudah berubah, sinkron ulang', 409, { v: cur ? cur.v : 0 });
    const rec = { v: b.v + 1, d: b.d, t: Date.now(), wh };
    await kv(['SET', key, JSON.stringify(rec)]);
    return J({ v: rec.v, t: rec.t });
  } catch {
    return E('Penyimpanan tidak bisa dihubungi', 502);
  }
}
