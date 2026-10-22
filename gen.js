// Vercel Edge Function: generator gambar dan video lewat Replicate. Letakkan sebagai api/gen.js
// Env wajib: REPLICATE_API_TOKEN (replicate.com/account/api-tokens)
// Env opsional: IMAGE_MODEL (bawaan black-forest-labs/flux-schnell), VIDEO_MODEL (kosong = fitur video mati; isi mis. "owner/nama-model"),
//   IMAGE_INPUT / VIDEO_INPUT (JSON tambahan untuk input model), GEN_IMG_DAILY (bawaan 30), GEN_VID_DAILY (bawaan 5),
//   REPLICATE_URL (bawaan https://api.replicate.com/v1), PRO_SECRET + KV_REST_API_URL/TOKEN (batas harian per lisensi).
// Khusus Pro. Bila PRO_SECRET kosong (sistem Pro mati), semua pengguna boleh tetapi tetap dibatasi per IP.
export const config = { runtime: 'edge' };

const TOKEN = (process.env.REPLICATE_API_TOKEN || '').trim();
const BASE = (process.env.REPLICATE_URL || 'https://api.replicate.com/v1').trim().replace(/\/+$/, '');
const IMG_MODEL = (process.env.IMAGE_MODEL || 'black-forest-labs/flux-schnell').trim();
const VID_MODEL = (process.env.VIDEO_MODEL || '').trim();
const LIM = { image: +process.env.GEN_IMG_DAILY || 30, video: +process.env.GEN_VID_DAILY || 5 };
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
    return p.p === 'pro' && p.e > Date.now() ? { pro: true, id: String(p.c || '') || null } : { pro: false };
  } catch { return { pro: false }; }
}
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
    return J({ enabled: !!TOKEN, image: !!TOKEN, video: !!(TOKEN && VID_MODEL), limits: LIM });
  }
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!TOKEN) return E('Generator belum diatur di server (REPLICATE_API_TOKEN)', 503);
  if (+req.headers.get('content-length') > 20000) return E('Permintaan terlalu besar', 413);
  const L = await lic(req);
  if (!L.pro) return E('Pembuat gambar dan video khusus Pro.', 402, 'pro_required');
  if (limited('p:' + ip, 40, 10 * 60e3)) return E('Terlalu banyak permintaan. Coba lagi sebentar.', 429);

  const d = await req.json().catch(() => null);
  if (!d) return E('Body tidak valid', 400);
  const hdr = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };

  if (d.action === 'create') {
    const kind = d.kind === 'video' ? 'video' : 'image';
    const model = kind === 'video' ? VID_MODEL : IMG_MODEL;
    if (!model) return E('Pembuat video belum diaktifkan di server (VIDEO_MODEL)', 503);
    const prompt = String(d.prompt || '').trim().slice(0, 1500);
    if (prompt.length < 3) return E('Tulis deskripsi dulu', 400);
    const ratio = ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(d.ratio) ? d.ratio : '1:1';
    // kuota harian
    if (KV_URL && KV_TOKEN) {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const key = `auralis:gen:${kind}:${L.id || 'ip-' + ip}:${day}`;
        const n = await kv(['INCR', key]);
        if (n === 1) await kv(['EXPIRE', key, 90000]);
        if (n > LIM[kind]) return E(`Batas harian ${kind === 'video' ? 'video' : 'gambar'} tercapai (${LIM[kind]}/hari). Coba lagi besok.`, 429, 'quota');
      } catch { return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
    } else if (limited('q:' + (L.id || ip) + kind, LIM[kind], 864e5)) return E('Batas harian tercapai', 429, 'quota');
    const extra = j(process.env[kind === 'video' ? 'VIDEO_INPUT' : 'IMAGE_INPUT'], {});
    const base = kind === 'image' ? { prompt, aspect_ratio: ratio, num_outputs: 1, output_format: 'webp' } : { prompt, aspect_ratio: ratio };
    const [name, ver] = model.split(':');
    const url = ver ? BASE + '/predictions' : BASE + '/models/' + name + '/predictions';
    const call = input => fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify(ver ? { version: ver, input } : { input }) });
    let r;
    try {
      r = await call({ ...base, ...extra });
      if (r.status === 422) r = await call({ prompt, ...extra }); // model tidak mengenal parameter tambahan
    } catch { return E('Penyedia tidak bisa dihubungi', 502); }
    const p = await r.json().catch(() => ({}));
    if (!r.ok || !p.id) return E(String(p.detail || p.title || 'Penyedia menolak permintaan').slice(0, 200), r.status === 402 ? 502 : (r.status >= 500 ? 502 : 400));
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
    return J({ ok: true, status: p.status, file: p.status === 'succeeded' ? file : null, error: p.status === 'failed' || p.status === 'canceled' ? String(p.error || 'Gagal dibuat').slice(0, 200) : null });
  }
  return E('Aksi tidak dikenal', 400);
}

