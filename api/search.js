// Vercel Edge Function: pencarian web untuk Auralis. Letakkan sebagai api/search.js
// Env (pilih salah satu atau keduanya): TAVILY_API_KEY, BRAVE_API_KEY. Opsional: SEARCH_RATE_LIMIT, ALLOWED_ORIGINS.
// Bila dua kunci terpasang, keduanya dipanggil bersamaan dan hasil tercepat dipakai.
export const config = { runtime: 'edge' };

const TAV = (process.env.TAVILY_API_KEY || '').trim();
const BRV = (process.env.BRAVE_API_KEY || '').trim();
const TAV_URL = (process.env.TAVILY_URL || 'https://api.tavily.com/search').trim();
const BRV_URL = (process.env.BRAVE_URL || 'https://api.search.brave.com/res/v1/web/search').trim();
const TIMEOUT = 5000; // klien menunggu 6 detik, jadi server harus menyerah lebih dulu


// --- Pro: verifikasi token lisensi (PRO_SECRET). Bila PRO_SECRET kosong, sistem Pro nonaktif dan semua fitur terbuka. ---
const PRO_SECRET = (process.env.PRO_SECRET || '').trim();
const _enc = new TextEncoder();
const _unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function isPro(req) {
  if (!PRO_SECRET) return true;
  const t = req.headers.get('x-license') || '';
  const [body, sig] = t.split('.');
  if (!body || !sig) return false;
  try {
    const k = await crypto.subtle.importKey('raw', _enc.encode(PRO_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', k, _unb64u(sig), _enc.encode(body)))) return false;
    const p = JSON.parse(new TextDecoder().decode(_unb64u(body)));
    return p.p === 'pro' && p.e > Date.now();
  } catch { return false; }
}
const PRO_ERR = { error: { message: 'Fitur ini khusus Pro. Buka menu Atur > Langganan untuk upgrade.', code: 'pro_required' } };

const hits = new Map();
function limited(ip) {
  const now = Date.now(), LIM = +process.env.SEARCH_RATE_LIMIT || 30, WIN = 10 * 60e3;
  const a = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(ip, a);
  return false;
}

const clean = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const httpOnly = u => /^https?:\/\//i.test(u || '');
const bad = r => Object.assign(new Error('http ' + r.status), { status: r.status });

async function tavily(q) {
  const r = await fetch(TAV_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TAV },
    body: JSON.stringify({ query: q, max_results: 5, search_depth: 'basic' }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw bad(r);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.content) }));
}
async function brave(q) {
  const r = await fetch(BRV_URL + '?count=5&q=' + encodeURIComponent(q), {
    headers: { accept: 'application/json', 'x-subscription-token': BRV },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw bad(r);
  const j = await r.json();
  return ((j.web && j.web.results) || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.description) }));
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = {
    'access-control-allow-origin': ok && origin ? origin : own,
    'access-control-allow-headers': 'content-type,x-license',
    'access-control-allow-methods': 'GET,OPTIONS',
    vary: 'origin',
  };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st) => J({ error: { message: m } }, st);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  if (req.method !== 'GET') return E('Method tidak didukung', 405);

  const u = new URL(req.url);
  const enabled = !!(TAV || BRV);
  const q = (u.searchParams.get('q') || '').trim();
  if (!q) return J({ enabled });
  if (!enabled) return E('Pencarian web belum diatur di server', 503);
  if (!(await isPro(req))) return J(PRO_ERR, 402);
  if (q.length > 300) return E('Pertanyaan terlalu panjang', 400);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited(ip)) return E('Terlalu banyak pencarian. Coba lagi beberapa menit lagi.', 429);

  try {
    const jobs = [];
    if (TAV) jobs.push(tavily(q));
    if (BRV) jobs.push(brave(q));
    let results = await Promise.any(jobs); // yang tercepat berhasil dipakai; gagal hanya bila semuanya gagal
    results = results.filter(x => httpOnly(x.url)).slice(0, 5).map(x => ({ ...x, snippet: x.snippet.slice(0, 400) }));
    return J({ results });
  } catch (e) {
    const er = (e && e.errors && e.errors[0]) || e;
    if (er && (er.name === 'TimeoutError' || er.name === 'AbortError')) return E('Pencarian terlalu lama', 504);
    if (er && er.status) return E('Layanan pencarian menolak permintaan (' + er.status + ')', 502);
    return E('Layanan pencarian tidak bisa dihubungi', 502);
  }
}
