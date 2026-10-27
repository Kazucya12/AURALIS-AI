// Vercel Edge Function: pencarian web untuk Auralis (simpan sebagai api/search.js).
// Mesin: Tavily dan/atau Brave (cukup salah satu; bila dua-duanya ada, hasilnya digabung).
// Env: TAVILY_API_KEY dan/atau BRAVE_API_KEY. Opsional: QWEN_API_KEY + QWEN_BASE_URL (untuk memecah pertanyaan jadi beberapa kueri),
// SEARCH_PLAN_MODEL (default glm-5.3-flash), SEARCH_DAILY_FREE (15), SEARCH_DAILY_PRO (200), SEARCH_DEEP_DAILY (10), PRO_SECRET, KV_*.
// Mode: basic (1 kueri, semua pengguna) | multi (beberapa kueri + isi lebih panjang, Pro) | deep (riset mendalam, Pro).
export const config = { runtime: 'edge' };

const TAV = (process.env.TAVILY_API_KEY || process.env.TAVILY_KEY || '').trim();
const BRV = (process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_KEY || '').trim();
const GW_KEY = (process.env.QWEN_API_KEY || '').trim();
const GW_URL = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
  .trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
const PLAN_MODEL = (process.env.SEARCH_PLAN_MODEL || '').trim() || 'glm-5.3-flash';
const PRO_SECRET = (process.env.PRO_SECRET || '').trim();
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const LIM = { free: +process.env.SEARCH_DAILY_FREE || 15, pro: +process.env.SEARCH_DAILY_PRO || 200, deep: +process.env.SEARCH_DEEP_DAILY || 10 };
const READY = !!(TAV || BRV);
const enc = new TextEncoder();

const CFG = {
  basic: { queries: 1, results: 5, snippet: 400, depth: 'basic', ms: 6000 },
  multi: { queries: 3, results: 8, snippet: 600, depth: 'advanced', ms: 13000 },
  deep: { queries: 5, results: 12, snippet: 900, depth: 'advanced', ms: 21000 },
};

const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function isPro(req) {
  if (!PRO_SECRET) return true;
  const [body, sig] = (req.headers.get('x-license') || '').split('.');
  if (!body || !sig) return false;
  try {
    const k = await crypto.subtle.importKey('raw', enc.encode(PRO_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', k, unb64u(sig), enc.encode(body)))) return false;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return p.p === 'pro' && p.e > Date.now();
  } catch { return false; }
}

async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv');
  return (await r.json()).result;
}
const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const hits = new Map();
function memLimited(key, n) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < 864e5);
  if (a.length >= n) return true;
  a.push(now); hits.set(key, a); return false;
}
// Hitung pemakaian harian per akun/IP. true = sudah melewati batas.
async function overLimit(kind, who, lim) {
  if (KV_URL && KV_TOKEN) {
    try {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(who)));
      const key = 'auralis:sr:' + kind + ':' + [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('') + ':' + dayKey();
      const n = await kv(['INCR', key]);
      if (n === 1) await kv(['EXPIRE', key, 90000]);
      return n > lim;
    } catch {}
  }
  return memLimited(kind + who, lim);
}

const NEWS = /\b(berita|terbaru|terkini|hari ini|kemarin|minggu ini|barusan|breaking|skor|klasemen|hasil pertandingan|viral|trending|news|latest|today|yesterday)\b/i;
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = u => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, ''); } catch { return u; } };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// Pecah pertanyaan jadi beberapa kueri pencarian berbeda sudut (pakai model cepat; gagal = pakai kueri asli saja)
async function planQueries(q, n) {
  const out = [q];
  if (n <= 1 || !GW_KEY) return out;
  try {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 3500);
    const r = await fetch(GW_URL, {
      method: 'POST', signal: c.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({
        model: PLAN_MODEL, max_tokens: 220, temperature: 0.2, stream: false,
        messages: [
          { role: 'system', content: 'Ubah pertanyaan pengguna menjadi ' + (n - 1) + ' kueri pencarian web singkat (2 sampai 8 kata) dari sudut pandang berbeda agar cakupan hasil luas. Sertakan satu kueri berbahasa Inggris bila topiknya internasional. Jawab HANYA array JSON berisi string, tanpa teks lain.' },
          { role: 'user', content: q },
        ],
      }),
    });
    clearTimeout(t);
    if (!r.ok) return out;
    const j = await r.json(), txt = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
    const m = txt.match(/\[[\s\S]*\]/);
    if (m) for (const x of JSON.parse(m[0])) { const s = clean(x).slice(0, 120); if (s.length > 2 && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s); }
  } catch {}
  return out.slice(0, n);
}

async function tavily(q, cfg, news, signal) {
  const body = { query: q, search_depth: cfg.depth, max_results: Math.min(10, cfg.results), include_answer: false };
  if (cfg.depth === 'advanced') body.chunks_per_source = 3;
  if (news) { body.topic = 'news'; body.time_range = 'week'; }
  const r = await fetch('https://api.tavily.com/search', { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TAV }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('tavily ' + r.status);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.content) }));
}
async function brave(q, cfg, news, signal) {
  const u = 'https://api.search.brave.com/res/v1/' + (news ? 'news' : 'web') + '/search?q=' + encodeURIComponent(q) + '&count=' + Math.min(10, cfg.results) + (cfg.depth === 'advanced' ? '&extra_snippets=true' : '');
  const r = await fetch(u, { signal, headers: { accept: 'application/json', 'x-subscription-token': BRV } });
  if (!r.ok) throw new Error('brave ' + r.status);
  const j = await r.json(), arr = news ? (j.results || []) : ((j.web && j.web.results) || []);
  return arr.map(x => ({ title: clean(String(x.title || '').replace(/<[^>]+>/g, '')), url: x.url, snippet: clean([x.description].concat(x.extra_snippets || []).join(' ').replace(/<[^>]+>/g, '')) }));
}

// Gabungkan beberapa daftar hasil: selang-seling, buang URL kembar, maksimal 2 hasil per situs
function merge(lists, max, snip) {
  const seen = new Set(), per = {}, out = [];
  for (let i = 0; out.length < max; i++) {
    let any = false;
    for (const l of lists) {
      if (i >= l.length) continue;
      any = true;
      const x = l[i];
      if (!x || !/^https?:\/\//i.test(x.url || '')) continue;
      const k = norm(x.url), h = host(x.url);
      if (seen.has(k) || (per[h] || 0) >= 2) continue;
      seen.add(k); per[h] = (per[h] || 0) + 1;
      out.push({ title: x.title || x.url, url: x.url, snippet: (x.snippet || '').slice(0, snip) });
      if (out.length >= max) break;
    }
    if (!any) break;
  }
  return out;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-license,x-uid', 'access-control-allow-methods': 'GET,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st) => J({ error: { message: m } }, st);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  if (req.method !== 'GET') return E('Metode tidak didukung', 405);

  const u = new URL(req.url), q = clean(u.searchParams.get('q')).slice(0, 300);
  if (!q) return J({ enabled: READY, engines: { tavily: !!TAV, brave: !!BRV }, modes: ['basic', 'multi', 'deep'] });
  if (!READY) return E('Pencarian belum diatur di server (isi TAVILY_API_KEY atau BRAVE_API_KEY)', 503);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const uid = (req.headers.get('x-uid') || '').replace(/[^\w-]/g, '').slice(0, 40);
  const who = ip + (uid ? ':' + uid : '');
  const pro = await isPro(req);

  // Mode multi/deep khusus Pro; pengguna gratis otomatis dibuat basic
  let mode = ['basic', 'multi', 'deep'].includes(u.searchParams.get('mode')) ? u.searchParams.get('mode') : 'basic';
  if (!pro) mode = 'basic';
  if (mode === 'deep' && await overLimit('deep', who, LIM.deep)) mode = 'multi';
  if (await overLimit(pro ? 'pro' : 'free', who, pro ? LIM.pro : LIM.free)) return E('Batas pencarian web hari ini tercapai (' + (pro ? LIM.pro : LIM.free) + '/hari). Coba lagi besok.', 429);

  const cfg = CFG[mode], news = NEWS.test(q);
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), cfg.ms);
  try {
    const queries = await planQueries(q, cfg.queries);
    const jobs = [];
    for (const qq of queries) {
      if (TAV) jobs.push(tavily(qq, cfg, news, ac.signal).catch(() => (BRV && mode === 'basic' ? brave(qq, cfg, news, ac.signal).catch(() => []) : [])));
      if (BRV && (mode !== 'basic' || !TAV)) jobs.push(brave(qq, cfg, news, ac.signal).catch(() => []));
    }
    const lists = await Promise.all(jobs);
    const results = merge(lists, cfg.results, cfg.snippet);
    return J({ results, mode, queries, news });
  } catch {
    return E('Pencarian gagal atau terlalu lama', 504);
  } finally { clearTimeout(tm); }
}
