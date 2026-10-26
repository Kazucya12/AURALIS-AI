// Vercel Edge Function: generator gambar GRATIS lewat Cloudflare Workers AI (FLUX.1 schnell). Letakkan sebagai api/gen.js
// Env wajib: CF_ACCOUNT_ID, CF_API_TOKEN (token dengan izin Workers AI)
// Env opsional: CF_IMAGE_MODEL (bawaan @cf/black-forest-labs/flux-1-schnell), CF_IMAGE_STEPS (bawaan 4, maks 8),
//   GEN_IMG_DAILY (bawaan 30 per pengguna per hari), GEN_IMG_GLOBAL_DAILY (bawaan 200 untuk semua pengguna),
//   GEN_IMG_TOKENS (biaya kuota token per gambar, bawaan 500), TOKEN_LIMIT_FREE / TOKEN_LIMIT_PRO,
//   PRO_SECRET + KV_REST_API_URL/TOKEN (kuota per lisensi), ALLOWED_ORIGINS.
// Versi gratis: gambar (1:1) dan edit foto (img2img: chibi, anime, kartun, dll). Video tidak tersedia.
// Env opsional edit: CF_EDIT_MODEL, GEN_EDIT_DAILY (20), GEN_EDIT_GLOBAL_DAILY (100), GEN_EDIT_TOKENS (800).
// Gambar yang gagal dibuat tidak memotong kuota.
export const config = { runtime: 'edge' };

const ACC = (process.env.CF_ACCOUNT_ID || '').trim();
const TOKEN = (process.env.CF_API_TOKEN || '').trim();
const MODEL = (process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell').trim();
const STEPS = Math.min(8, Math.max(1, +process.env.CF_IMAGE_STEPS || 4));
const EDIT_MODEL = (process.env.CF_EDIT_MODEL || '@cf/runwayml/stable-diffusion-v1-5-img2img').trim();
const STY = [
  [/chibi/i, 'chibi style, cute, big head, small body, anime, 2d illustration, vibrant colors, clean line art', 0.78],
  [/anime|manga|ghibli/i, 'anime style, cel shading, vibrant colors, clean line art, detailed eyes', 0.68],
  [/kartun|cartoon/i, 'cartoon style, bold outlines, flat colors', 0.68],
  [/pixar|3d/i, '3D render, pixar style, soft lighting, smooth skin', 0.65],
  [/pixel/i, 'pixel art, 16-bit, retro game sprite', 0.8],
  [/cat air|watercolou?r/i, 'watercolor painting, soft washes, paper texture', 0.65],
  [/sketsa|pensil|sketch|pencil/i, 'pencil sketch, detailed shading, monochrome', 0.7],
  [/lukisan|minyak|painting/i, 'oil painting, brush strokes, rich colors', 0.65],
];
// mode 'b64' = foto sebagai string base64 (utama); 'arr' = foto sebagai larik byte (cadangan)
function editBody(prompt, bytes, b64, str, mode) {
  const st = STY.find(x => x[0].test(prompt));
  const body = { prompt: prompt + (st ? ', ' + st[1] : '') + ', masterpiece, best quality, highly detailed', negative_prompt: 'lowres, bad anatomy, deformed face, extra fingers, blurry, text, watermark, nsfw', strength: str || (st ? st[2] : 0.6), num_steps: 20, guidance: 7.5 };
  if (mode === 'arr') body.image = Array.from(bytes); else body.image_b64 = b64;
  return body;
}
const READY = !!(ACC && TOKEN);
const LIM = { image: +process.env.GEN_IMG_DAILY || 30, edit: +process.env.GEN_EDIT_DAILY || 20 };
const CAP = { image: +process.env.GEN_IMG_GLOBAL_DAILY || 200, edit: +process.env.GEN_EDIT_GLOBAL_DAILY || 100 };
const PRO_SECRET = (process.env.PRO_SECRET || '').trim();
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const enc = new TextEncoder();

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
    return p.p === 'pro' && p.e > Date.now() ? { pro: true, id: String(p.c || '') || null, who: 'L' + String(p.c || p.e) } : { pro: false };
  } catch { return { pro: false }; }
}
const TOK_FREE = +process.env.TOKEN_LIMIT_FREE || 15000, TOK_PRO = +process.env.TOKEN_LIMIT_PRO || 50000, TOK_WIN = 6 * 3600;
const COST = { image: +process.env.GEN_IMG_TOKENS || 500, video: 0, edit: +process.env.GEN_EDIT_TOKENS || 800 };
const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
async function tokKey(who) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(who))); return 'auralis:tk:' + [...h.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function stat(name, by) { try { const k = 'auralis:st:' + dayKey() + ':' + name, n = await kv(['INCRBY', k, by || 1]); if (n === (by || 1)) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }
const RLD = async (kind, ip, lim, win = 600) => { // batas laju bersama lewat Upstash, cadangan memori
  if (KV_URL && KV_TOKEN) {
    try {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('rl' + ip))), hx = [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
      const key = 'auralis:rl:g' + kind + ':' + hx + ':' + Math.floor(Date.now() / (win * 1000)), n = await kv(['INCR', key]);
      if (n === 1) await kv(['EXPIRE', key, win * 2]);
      return n > lim;
    } catch {}
  }
  return limited(kind + ip, lim, win * 1000);
};
// pengaturan dari panel admin (KV auralis:cfg), menimpa env; di-cache 30 detik
let CFG = {}, CFGT = 0;
async function cfg() {
  if (!KV_URL || !KV_TOKEN || Date.now() - CFGT < 30000) return CFG;
  CFGT = Date.now();
  try { const r = await kv(['GET', 'auralis:cfg']); CFG = r ? JSON.parse(r) : {}; } catch {}
  return CFG;
}
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(+v)) ? d : +v;
const hits = new Map();
function limited(key, n, win) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win);
  if (a.length >= n) return true;
  a.push(now); hits.set(key, a); return false;
}
const toB64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-license', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st, code) => J({ error: { message: m, code } }, st);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const C = await cfg();
  const LIMr = { image: num(C.imgDaily, LIM.image), edit: num(C.editDaily, LIM.edit) }, CAPr = { image: num(C.capImg, CAP.image), edit: num(C.capEdit, CAP.edit) };
  const COSTr = { image: num(C.imgTok, COST.image), edit: num(C.editTok, COST.edit), video: 0 };
  const TF = num(C.tokFree, TOK_FREE), TP = num(C.tokPro, TOK_PRO), TW = num(C.winH, 6) * 3600;

  if (req.method === 'GET') return J({ enabled: READY, image: READY, video: false, edit: READY, limits: LIMr, costs: COSTr });
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!READY) return E('Generator belum diatur di server (CF_ACCOUNT_ID dan CF_API_TOKEN)', 503);
  if (+req.headers.get('content-length') > 1.6e6) return E('Permintaan terlalu besar', 413);
  const L = await lic(req); // akun gratis juga boleh; dibatasi kuota token dan batas harian
  const d = await req.json().catch(() => null);
  if (!d) return E('Body tidak valid', 400);
  if (d.action !== 'create') return E('Aksi tidak dikenal', 400);
  if (await RLD('c', ip, 40)) return E('Terlalu banyak permintaan. Coba lagi sebentar.', 429);

  if (d.kind === 'video') return E('Video belum tersedia di versi gratis', 503);
  const kind = d.kind === 'edit' ? 'edit' : 'image';
  const prompt = String(d.prompt || '').trim().slice(0, 1500);
  if (prompt.length < 3) return E('Tulis deskripsi dulu', 400);
  let imgBytes = null, imgB64 = '';
  if (kind === 'edit') {
    const im = String(d.image || ''), mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(im);
    if (!mm || im.length > 1.4e6) return E('Gambar yang diedit tidak valid atau terlalu besar', 400);
    try { imgB64 = mm[2]; imgBytes = Uint8Array.from(atob(imgB64), c => c.charCodeAt(0)); } catch { return E('Gambar tidak bisa dibaca', 400); }
  }

  // kuota token (dipotong setelah gambar berhasil dibuat)
  let tk = null;
  if (PRO_SECRET && KV_URL && KV_TOKEN) {
    try {
      const key = await tokKey(L.who || 'I' + ip), limit = L.pro ? TP : TF, used = +(await kv(['GET', key])) || 0;
      if (used + COSTr[kind] > limit) {
        const ttl = used ? await kv(['PTTL', key]) : -2, mnt = Math.ceil((ttl > 0 ? ttl : TW * 1000) / 60000);
        return E(`Kuota token tidak cukup untuk gambar (butuh sekitar ${COSTr[kind]}). Reset dalam ${Math.floor(mnt / 60)} jam ${mnt % 60} menit.`, 429, 'quota');
      }
      tk = { key };
    } catch {}
  }
  // kuota harian per pengguna + plafon global per hari; dikembalikan bila penyedia gagal
  const taken = [], undo = async () => { for (const k of taken) { try { await kv(['DECR', k]); } catch {} } };
  if (KV_URL && KV_TOKEN) {
    try {
      const day = dayKey();
      const uk = `auralis:gen:${kind}:${L.id || 'ip-' + ip}:${day}`, gk = `auralis:gen:cap:${kind}:${day}`;
      for (const [k, lim, msg, code] of [
        [uk, LIMr[kind], `Batas harian gambar tercapai (${LIMr[kind]}/hari). Coba lagi besok.`, 'quota'],
        [gk, CAPr[kind], 'Kapasitas gambar hari ini sudah penuh untuk semua pengguna. Coba lagi besok.', 'capacity'],
      ]) {
        const n = await kv(['INCR', k]); taken.push(k);
        if (n === 1) await kv(['EXPIRE', k, 90000]);
        if (n > lim) { await undo(); return E(msg, 429, code); }
      }
    } catch { await undo(); return E('Penyimpanan sementara bermasalah. Coba lagi.', 503); }
  } else if (limited('q:' + (L.id || ip) + kind, LIMr[kind], 864e5)) return E('Batas harian tercapai', 429, 'quota');

  // panggil Cloudflare Workers AI (gambar langsung dikembalikan, tanpa polling)
  let img = '', mime = 'image/jpeg', em = '', st = 0;
  try {
    const strength = +d.strength > 0 ? Math.min(0.95, Math.max(0.2, +d.strength)) : 0;
    const modes = kind === 'edit' ? ['b64', 'arr'] : ['t2i']; // edit: coba base64 dulu, lalu larik byte
    for (const mode of modes) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${kind === 'edit' ? EDIT_MODEL : MODEL}`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'edit' ? editBody(prompt, imgBytes, imgB64, strength, mode) : { prompt, steps: STEPS }),
      });
      st = r.status;
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.startsWith('image/')) { mime = ct.split(';')[0]; img = toB64(await r.arrayBuffer()); }
      else {
        const p = await r.json().catch(() => ({}));
        img = (r.ok && p && p.result && p.result.image) || '';
        em = String((p.errors && p.errors[0] && p.errors[0].message) || p.error || '');
      }
      if (img || st === 401 || st === 403 || st === 429) break;
    }
  } catch { await undo(); return E('Penyedia tidak bisa dihubungi', 502); }
  // cadangan edit: bila img2img gagal, model gambar-ke-teks mendeskripsikan foto lalu FLUX membuat versi gayanya
  if (!img && kind === 'edit' && ![401, 403, 429].includes(st)) {
    try {
      const run = (model, body) => fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${model}`, { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const dr = await run('@cf/llava-hf/llava-1.5-7b-hf', { image: Array.from(imgBytes), prompt: 'Describe the main person or subject in this photo in one detailed sentence: gender, age, hair, clothing, expression, pose and background.', max_tokens: 160 });
      const dj = await dr.json().catch(() => ({}));
      const desc = String((dj.result && (dj.result.description || dj.result.response)) || '').trim().slice(0, 500);
      if (desc) {
        const stl = STY.find(x => x[0].test(prompt));
        const fr = await run(MODEL, { prompt: (stl ? stl[1] : prompt.slice(0, 200)) + ', illustration of ' + desc + ', masterpiece, best quality, highly detailed', steps: STEPS });
        const ct = fr.headers.get('content-type') || '';
        if (fr.ok && ct.startsWith('image/')) { mime = ct.split(';')[0]; img = toB64(await fr.arrayBuffer()); }
        else { const fj = await fr.json().catch(() => ({})); img = (fr.ok && fj && fj.result && fj.result.image) || ''; }
      }
    } catch {}
  }
  if (!img) {
    await undo();
    if (st === 429 || /allocation|neurons|rate|limit/i.test(em)) return E('Kuota gratis generator hari ini habis. Coba lagi besok.', 429, 'capacity');
    if (st === 401 || st === 403) return E('Token Cloudflare ditolak. Periksa CF_API_TOKEN dan izin Workers AI.', 502);
    return E(((kind === 'edit' ? 'Edit foto gagal (' + st + '): ' : '') + (em || 'Penyedia menolak permintaan')).slice(0, 240), st >= 500 ? 502 : 400);
  }
  if (tk) { try { const r2 = await kv(['INCRBY', tk.key, COSTr[kind]]); if (r2 === COSTr[kind]) await kv(['EXPIRE', tk.key, TW]); } catch {} }
  if (KV_URL && KV_TOKEN) await Promise.all([stat('tok', COSTr[kind]), stat('tm:gen-' + kind, COSTr[kind]), stat('tf:gen', COSTr[kind]), stat('gen_' + kind)]); // statistik admin
  return J({ ok: true, id: 'cf', kind, img: `data:${mime};base64,${img}` });
}
