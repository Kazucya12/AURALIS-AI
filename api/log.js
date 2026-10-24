// Vercel Edge Function: log kesalahan, umpan balik 👍👎, statistik, dan status layanan. Letakkan sebagai api/log.js
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (Upstash). Opsional: GATEWAY_URL/QWEN_BASE_URL + QWEN_API_KEY (untuk cek gateway di halaman status), ALLOWED_ORIGINS.
// GET            -> status publik {ok, kv, gw}
// GET + admin    -> ?stats=1 : statistik 14 hari dan 50 error terbaru (header x-admin-session)
// POST {t:'err'|'fb'|'ev'}  -> dicatat (dibatasi per IP, isi dipotong, tanpa data pribadi)
// Tarif untuk estimasi biaya (opsional, isi agar akurat): COST_TOK_PER_M_USD, COST_IMG_USD, COST_VID_USD, COST_EDIT_USD, USD_IDR.
// Peringatan: ALERT_COST_IDR (batas biaya harian, 0 = mati), plafon gen dibaca dari GEN_*_GLOBAL_DAILY (sama dengan api/gen.js).
export const config = { runtime: 'edge' };

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const ADMIN = (process.env.PRO_ADMIN_KEY || '').trim();
const enc = new TextEncoder();
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
const same = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
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
const dayOf = off => new Date(Date.now() + 7 * 3600e3 - off * 864e5).toISOString().slice(0, 10);
async function stat(name) { try { const k = 'auralis:st:' + dayOf(0) + ':' + name, n = await kv(['INCR', k]); if (n === 1) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }

const hits = new Map();
function limited(key, LIM) {
  const now = Date.now(), WIN = 10 * 60e3, a = (hits.get(key) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(key, a); return false;
}
let GWC = { t: 0, ok: null };
async function gwOk() {
  if (Date.now() - GWC.t < 60e3) return GWC.ok;
  const base = (process.env.GATEWAY_URL || process.env.QWEN_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, ''), key = (process.env.QWEN_API_KEY || '').trim();
  let ok = null;
  if (base) { try { const c = new AbortController(), t = setTimeout(() => c.abort(), 4000); const r = await fetch(base + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: c.signal }); clearTimeout(t); ok = r.status < 500; } catch { ok = false; } }
  GWC = { t: Date.now(), ok };
  return ok;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-admin,x-admin-session', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return J({ error: { message: 'Origin tidak diizinkan' } }, 403);
  const have = !!(KV_URL && KV_TOKEN);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('stats')) {
      if (limited('s' + ip, 60)) return J({ error: { message: 'Terlalu banyak permintaan' } }, 429);
      if (!have || !(await adminOk(req))) return J({ error: { message: 'Akses admin ditolak' } }, 403);
      const names = ['chat', 'tok', 'err', 'up', 'dn', 'signup', 'trial', 'ref', 'ref_claim', 'blocked', 'trial_denied',
        'uok', 'umiss', 'gen_image', 'gen_video', 'gen_edit', 'gen_fail_image', 'gen_fail_video', 'gen_fail_edit', 'web',
        'tf:chat', 'tf:sug', 'tf:mem', 'tf:cls', 'tf:sum', 'tf:gen'], days = [];
      for (let i = 0; i < 14; i++) days.push(dayOf(i));
      const keys = []; days.forEach(d => names.forEach(n => keys.push('auralis:st:' + d + ':' + n)));
      const vals = await kv(['MGET', ...keys]);
      const rows = days.map((d, i) => { const o = { d }; names.forEach((n, j) => { o[n] = +vals[i * names.length + j] || 0; }); return o; });
      // model terpakai hari ini dan kemarin
      const mk = []; for (const d of days.slice(0, 7)) { let cur = 0, ks = []; do { const r = await kv(['SCAN', cur, 'MATCH', 'auralis:st:' + d + ':m:*', 'COUNT', 200]); cur = +r[0]; ks = ks.concat(r[1]); } while (cur && ks.length < 60); mk.push(...ks.slice(0, 60)); }
      const mv = mk.length ? await kv(['MGET', ...mk]) : [], models = {};
      mk.forEach((k, i) => { const m = k.split(':m:')[1]; models[m] = (models[m] || 0) + (+mv[i] || 0); });
      // token per model (7 hari)
      const tkk = []; for (const d of days.slice(0, 7)) { let cur = 0, ks = []; do { const r = await kv(['SCAN', cur, 'MATCH', 'auralis:st:' + d + ':tm:*', 'COUNT', 200]); cur = +r[0]; ks = ks.concat(r[1]); } while (cur && ks.length < 60); tkk.push(...ks.slice(0, 60)); }
      const tkv = tkk.length ? await kv(['MGET', ...tkk]) : [], tmodels = {};
      tkk.forEach((k, i) => { const m = k.split(':tm:')[1]; tmodels[m] = (tmodels[m] || 0) + (+tkv[i] || 0); });
      const errs = ((await kv(['LRANGE', 'auralis:log:err', 0, 49])) || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
      const fb = ((await kv(['HGETALL', 'auralis:fb:model'])) || []), fbm = {};
      for (let i = 0; i < fb.length; i += 2) { const [m, v] = String(fb[i]).split('|'); (fbm[m] = fbm[m] || { up: 0, dn: 0 })[v] = +fb[i + 1] || 0; }
      // estimasi biaya (rupiah) per hari + peringatan otomatis
      const R = { tokM: +process.env.COST_TOK_PER_M_USD || 0.5, img: +process.env.COST_IMG_USD || 0.003, vid: +process.env.COST_VID_USD || 0.25, edit: +process.env.COST_EDIT_USD || 0.04, idr: +process.env.USD_IDR || 16500 };
      const rateEst = !(process.env.COST_TOK_PER_M_USD && process.env.COST_VID_USD);
      const GT = { image: +process.env.GEN_IMG_TOKENS || 1500, video: +process.env.GEN_VID_TOKENS || 6000, edit: +process.env.GEN_EDIT_TOKENS || 3000 };
      const CAP = { image: +process.env.GEN_IMG_GLOBAL_DAILY || 300, video: +process.env.GEN_VID_GLOBAL_DAILY || 30, edit: +process.env.GEN_EDIT_GLOBAL_DAILY || 100 };
      rows.forEach(o => {
        const g = k => Math.max(0, (o['gen_' + k] || 0) - (o['gen_fail_' + k] || 0));
        const gTok = g('image') * GT.image + g('video') * GT.video + g('edit') * GT.edit;
        const usd = Math.max(0, (o.tok || 0) - gTok) / 1e6 * R.tokM + g('image') * R.img + g('video') * R.vid + g('edit') * R.edit;
        o.cost = Math.round(usd * R.idr);
      });
      const alerts = [], t0 = rows[0], prev = rows.slice(1, 8), nf = n => Math.round(n).toLocaleString('id-ID');
      const avg = k => prev.length ? prev.reduce((a, x) => a + (x[k] || 0), 0) / prev.length : 0;
      if ((t0.tok || 0) > 50000 && t0.tok > 2.5 * avg('tok')) alerts.push({ lv: 'warn', m: `Token hari ini ${nf(t0.tok)} jauh di atas rata-rata 7 hari terakhir (${nf(avg('tok'))}).` });
      if (t0.err >= 10 && t0.err > 3 * Math.max(1, avg('err'))) alerts.push({ lv: 'warn', m: `Error hari ini ${t0.err}, jauh di atas biasanya (${nf(avg('err'))}). Cek daftar error terbaru.` });
      for (const [k, nm] of [['image', 'gambar'], ['video', 'video'], ['edit', 'edit gambar']]) { const u = t0['gen_' + k] || 0; if (u >= 0.8 * CAP[k]) alerts.push({ lv: 'warn', m: `Plafon ${nm} hari ini hampir penuh (${u}/${CAP[k]}).` }); }
      const lim = +process.env.ALERT_COST_IDR || 0;
      if (lim > 0 && t0.cost >= lim) alerts.push({ lv: 'warn', m: `Estimasi biaya hari ini Rp ${nf(t0.cost)} melewati batas Rp ${nf(lim)}.` });
      const un = (t0.uok || 0) + (t0.umiss || 0);
      if (un >= 20 && (t0.uok || 0) / un < 0.5) alerts.push({ lv: 'info', m: `Gateway hanya mengirim usage asli di ${Math.round((t0.uok || 0) / un * 100)}% permintaan; sisanya token dihitung dari perkiraan.` });
      return J({ ok: true, rows, rates: { ...R, est: rateEst }, alerts, models, tmodels, errs, fb: fbm, lic: +(await kv(['SCARD', 'auralis:lic:index'])) || 0 });
    }
    const t0 = Date.now();
    let kvOk = null;
    if (have) { try { kvOk = (await kv(['PING'])) === 'PONG'; } catch { kvOk = false; } }
    return J({ ok: kvOk !== false, kv: kvOk, gw: await gwOk(), ms: Date.now() - t0, t: Date.now() });
  }
  if (req.method !== 'POST') return J({ error: { message: 'Method tidak didukung' } }, 405);
  if (!have) return J({ ok: true, skipped: true });
  if (limited('p' + ip, 30)) return J({ ok: true, skipped: true });
  let b; try { b = await req.json(); } catch { return J({ error: { message: 'Body tidak valid' } }, 400); }
  try {
    if (b.t === 'err') {
      const e = { t: Date.now(), m: String(b.m || '').replace(/[\r\n]+/g, ' ').slice(0, 300), w: String(b.w || '').slice(0, 40), v: String(b.v || '').slice(0, 20), ua: String(req.headers.get('user-agent') || '').slice(0, 90) };
      if (!e.m) return J({ ok: true });
      await kv(['LPUSH', 'auralis:log:err', JSON.stringify(e)]); await kv(['LTRIM', 'auralis:log:err', 0, 99]); await stat('err');
      return J({ ok: true });
    }
    if (b.t === 'ev') { // penghitung kejadian sisi klien yang tidak terlihat server chat (daftar putih)
      if (b.k === 'web') await stat('web');
      return J({ ok: true });
    }
    if (b.t === 'fb') {
      const v = +b.v === 1 ? 'up' : +b.v === -1 ? 'dn' : '';
      if (!v) return J({ ok: true });
      const m = String(b.m || 'unknown').replace(/[|\s]+/g, '_').slice(0, 40);
      await stat(v); await kv(['HINCRBY', 'auralis:fb:model', m + '|' + v, 1]);
      return J({ ok: true });
    }
    return J({ error: { message: 'Jenis tidak dikenal' } }, 400);
  } catch { return J({ ok: true, skipped: true }); }
}
