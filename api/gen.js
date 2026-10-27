// Vercel Edge Function: generator gambar, edit foto, dan video lewat Replicate.
// Simpan sebagai api/gen.js. Env wajib: REPLICATE_API_TOKEN.
// Env opsional: REPLICATE_IMAGE_MODEL (flux-schnell), REPLICATE_EDIT_MODEL (flux-kontext-pro),
// REPLICATE_VIDEO_MODEL (seedance-1-lite), VIDEO_RESOLUTION (480p), VIDEO_DURATION (5 detik),
// GEN_VIDEO_DAILY (batas video per pengguna per hari, default 3), GEN_VIDEO_GLOBAL_DAILY (total semua pengguna, default 20).
export const config = { runtime: 'edge' };

const RTOKEN = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || process.env.REPLICATE_TOKEN || '').trim();
const MODEL_IMG = (process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-schnell').trim();
const MODEL_EDIT = (process.env.REPLICATE_EDIT_MODEL || 'black-forest-labs/flux-kontext-pro').trim();
const MODEL_VIDEO = (process.env.REPLICATE_VIDEO_MODEL || 'bytedance/seedance-1-lite').trim();
const VIDEO_RES = ['480p', '720p', '1080p'].includes((process.env.VIDEO_RESOLUTION || '').trim()) ? process.env.VIDEO_RESOLUTION.trim() : '480p';
const VIDEO_DUR = Math.min(12, Math.max(3, +process.env.VIDEO_DURATION || 5));
const RAPI = 'https://api.replicate.com/v1';
const rh = { authorization: 'Bearer ' + RTOKEN, 'content-type': 'application/json' };

const STY = [
  [/chibi/i, 'chibi anime style with a big head and small body, clean line art, vibrant colors'],
  [/anime|manga|ghibli/i, 'anime style illustration with cel shading, clean line art and vibrant colors'],
  [/kartun|cartoon/i, 'cartoon style with bold outlines and flat colors'],
  [/pixar|3d/i, 'a 3D animated movie style render with soft lighting'],
  [/pixel/i, '16-bit pixel art'],
  [/cat air|watercolou?r/i, 'a watercolor painting with soft washes'],
  [/sketsa|pensil|sketch|pencil/i, 'a detailed pencil sketch'],
  [/lukisan|minyak|painting/i, 'an oil painting with visible brush strokes'],
];

// Kontext memakai instruksi ("ubah jadi ..."), bukan kata kunci kualitas
function editPrompt(prompt) {
  const st = STY.find(x => x[0].test(prompt));
  return st
    ? 'Transform this image into ' + st[1] + '. Keep the same subject, composition and pose. ' + prompt
    : prompt + '. Keep the same subject and composition.';
}

const READY = !!RTOKEN;
const LIM = { text: +process.env.GEN_TEXT_DAILY || 100, image: +process.env.GEN_IMG_DAILY || 30, edit: +process.env.GEN_EDIT_DAILY || 20, video: +process.env.GEN_VIDEO_DAILY || 3 };
const CAP = { text: +process.env.GEN_TEXT_GLOBAL_DAILY || 1000, image: +process.env.GEN_IMG_GLOBAL_DAILY || 200, edit: +process.env.GEN_EDIT_GLOBAL_DAILY || 100, video: +process.env.GEN_VIDEO_GLOBAL_DAILY || 20 };
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
const COST = { text: +process.env.GEN_TEXT_TOKENS || 50, image: +process.env.GEN_IMG_TOKENS || 500, edit: +process.env.GEN_EDIT_TOKENS || 800, video: +process.env.GEN_VIDEO_TOKENS || 6000 };
const dayKey = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
async function tokKey(who) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(who))); return 'auralis:tk:' + [...h.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function stat(name, by) { try { const k = 'auralis:st:' + dayKey() + ':' + name, n = await kv(['INCRBY', k, by || 1]); if (n === (by || 1)) await kv(['EXPIRE', k, 40 * 86400]); } catch {} }

const RLD = async (kind, ip, lim, win = 600) => {
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

// Buat prediksi; bila model tidak punya endpoint resmi (404), pakai versi terbaru model tersebut
async function createPred(model, input) {
  let r = await fetch(RAPI + '/models/' + model + '/predictions', { method: 'POST', headers: rh, body: JSON.stringify({ input }) });
  if (r.status === 404) {
    const m = await fetch(RAPI + '/models/' + model, { headers: rh }).then(x => x.json()).catch(() => ({}));
    const v = m && m.latest_version && m.latest_version.id;
    if (v) r = await fetch(RAPI + '/predictions', { method: 'POST', headers: rh, body: JSON.stringify({ version: v, input }) });
  }
  return r;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = { 'access-control-allow-origin': ok && origin ? origin : own, 'access-control-allow-headers': 'content-type,x-license,x-uid', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const E = (m, st, code) => J({ error: { message: m, code } }, st);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return E('Origin tidak diizinkan', 403);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  // ID akun dari browser: memisahkan kuota antar akun yang berbagi IP yang sama
  const uid = (req.headers.get('x-uid') || '').replace(/[^\w-]/g, '').slice(0, 40);
  const who = ip + (uid ? ':' + uid : '');

  // Ambil hasil gambar dari Replicate (hanya host Replicate yang diizinkan)
  if (req.method === 'GET') {
    const u = new URL(req.url), f = u.searchParams.get('f');
    if (f) {
      let fu; try { fu = new URL(f); } catch { return E('Berkas tidak valid', 400); }
      if (fu.protocol !== 'https:' || !(fu.hostname === 'replicate.delivery' || fu.hostname.endsWith('.replicate.delivery'))) return E('Berkas tidak diizinkan', 400);
      const rr = req.headers.get('range');
      const r = await fetch(fu.href, rr ? { headers: { range: rr } } : {});
      if (!r.ok) return E('Hasil tidak bisa diambil (mungkin sudah kedaluwarsa)', 404);
      const h = { ...cors, 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) h[k] = v; }
      return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers: h });
    }
    const C0 = await cfg();
    return J({
      enabled: READY, text: false, image: READY, edit: READY, video: READY,
      limits: { text: num(C0.textDaily, LIM.text), image: num(C0.imgDaily, LIM.image), edit: num(C0.editDaily, LIM.edit), video: num(C0.vidDaily, LIM.video) },
      costs: { text: num(C0.textTok, COST.text), image: num(C0.imgTok, COST.image), edit: num(C0.editTok, COST.edit), video: num(C0.vidTok, COST.video) },
    });
  }
  if (req.method !== 'POST') return E('Metode tidak didukung', 405);
  if (!READY) return E('REPLICATE_API_TOKEN belum diatur di Vercel', 503);
  if (+req.headers.get('content-length') > 1.6e6) return E('Permintaan terlalu besar', 413);

  const d = await req.json().catch(() => null);
  if (!d) return E('Body tidak valid', 400);

  // Cek status prediksi (dipanggil berulang oleh index.html)
  if (d.action === 'status') {
    if (await RLD('s', ip, 900)) return E('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
    const id = String(d.id || '');
    if (!/^[a-z0-9]{8,40}$/i.test(id)) return E('ID tidak valid', 400);
    try {
      const r = await fetch(RAPI + '/predictions/' + id, { headers: rh });
      const p = await r.json().catch(() => ({}));
      if (!r.ok) return E('Gagal memeriksa status', 502);
      if (p.status === 'succeeded') {
        const out = Array.isArray(p.output) ? p.output[0] : p.output;
        if (!out || typeof out !== 'string') return J({ status: 'failed', error: 'Hasil kosong' });
        return J({ status: 'succeeded', file: out });
      }
      if (p.status === 'failed' || p.status === 'canceled') return J({ status: p.status, error: String(p.error || 'Gagal membuat hasil').slice(0, 240) });
      return J({ status: p.status || 'processing' });
    } catch { return E('Replicate tidak bisa dihubungi', 502); }
  }

  const C = await cfg();
  const LIMr = { text: num(C.textDaily, LIM.text), image: num(C.imgDaily, LIM.image), edit: num(C.editDaily, LIM.edit), video: num(C.vidDaily, LIM.video) };
  const CAPr = { text: num(C.capText, CAP.text), image: num(C.capImg, CAP.image), edit: num(C.capEdit, CAP.edit), video: num(C.capVid, CAP.video) };
  const COSTr = { text: num(C.textTok, COST.text), image: num(C.imgTok, COST.image), edit: num(C.editTok, COST.edit), video: num(C.vidTok, COST.video) };
  const TF = num(C.tokFree, TOK_FREE), TP = num(C.tokPro, TOK_PRO), TW = num(C.winH, 6) * 3600;

  const L = await lic(req);

  if (['text', 'chat'].includes(d.kind)) return E('Fitur teks tidak tersedia di endpoint ini. Gunakan /api/chat.', 400);
  const kind = d.kind === 'edit' ? 'edit' : d.kind === 'video' ? 'video' : 'image';
  const prompt = String(d.prompt || '').trim().slice(0, 4000);
  if (prompt.length < 3) return E('Tulis deskripsinya dulu', 400);

  if (await RLD('c', ip, 60)) return E('Terlalu banyak permintaan. Coba lagi sebentar.', 429);

  let imgUri = '';
  if (kind === 'edit') {
    const im = String(d.image || '');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(im) || im.length > 1.4e6) return E('Gambar yang diedit tidak valid atau terlalu besar', 400);
    imgUri = im;
  }

  // Cek kuota token
  let tk = null;
  if (PRO_SECRET && KV_URL && KV_TOKEN) {
    try {
      const key = await tokKey(L.who || 'I' + who), limit = L.pro ? TP : TF, used = +(await kv(['GET', key])) || 0;
      if (used + COSTr[kind] > limit) {
        const ttl = used ? await kv(['PTTL', key]) : -2, mnt = Math.ceil((ttl > 0 ? ttl : TW * 1000) / 60000);
        return E(`Kuota token tidak cukup (butuh ${COSTr[kind]}). Reset dalam ${Math.floor(mnt / 60)} jam ${mnt % 60} menit.`, 429, 'quota');
      }
      tk = { key };
    } catch {}
  }

  // Cek kuota harian & global
  const taken = [], undo = async () => { for (const k of taken) { try { await kv(['DECR', k]); } catch {} } };
  if (KV_URL && KV_TOKEN) {
    try {
      const day = dayKey();
      const uk = `auralis:gen:${kind}:${L.id || 'ip-' + who}:${day}`, gk = `auralis:gen:cap:${kind}:${day}`;
      for (const [k, lim, msg, code] of [
        [uk, LIMr[kind], `Batas harian ${kind} tercapai (${LIMr[kind]}/hari).`, 'quota'],
        [gk, CAPr[kind], `Kapasitas ${kind} hari ini penuh untuk semua pengguna.`, 'capacity'],
      ]) {
        const n = await kv(['INCR', k]); taken.push(k);
        if (n === 1) await kv(['EXPIRE', k, 90000]);
        if (n > lim) { await undo(); return E(msg, 429, code); }
      }
    } catch { await undo(); return E('Penyimpanan sementara bermasalah.', 503); }
  } else if (limited('q:' + (L.id || who) + kind, LIMr[kind], 864e5)) return E('Batas harian tercapai', 429, 'quota');

  // Buat prediksi di Replicate
  const ratio = ['1:1', '16:9', '9:16'].includes(d.ratio) ? d.ratio : '1:1';
  const input = kind === 'edit'
    ? { prompt: editPrompt(prompt), input_image: imgUri, aspect_ratio: 'match_input_image', output_format: 'jpg' }
    : kind === 'video'
      ? { prompt, aspect_ratio: ratio, duration: VIDEO_DUR, resolution: VIDEO_RES, fps: 24 }
      : { prompt, aspect_ratio: ratio, num_outputs: 1, output_format: 'jpg' };
  let id = '', st = 0, em = '';
  try {
    const r = await createPred(kind === 'edit' ? MODEL_EDIT : kind === 'video' ? MODEL_VIDEO : MODEL_IMG, input);
    st = r.status;
    const p = await r.json().catch(() => ({}));
    if (r.ok && p.id) id = p.id;
    else em = String(p.detail || p.title || p.error || '');
  } catch {
    await undo();
    return E('Replicate tidak bisa dihubungi', 502);
  }

  if (!id) {
    await undo();
    if (st === 402 || /credit|billing|insufficient/i.test(em)) return E('Saldo Replicate habis. Isi saldo di replicate.com/account/billing.', 502, 'capacity');
    if (st === 401) return E('Token Replicate ditolak. Periksa REPLICATE_API_TOKEN di Vercel.', 502);
    if (st === 429) return E('Replicate sedang sibuk. Coba lagi sebentar.', 429, 'capacity');
    return E((em || 'Replicate menolak permintaan').slice(0, 240), st >= 500 ? 502 : 400);
  }

  // Catat token & statistik
  if (tk) { try { const r2 = await kv(['INCRBY', tk.key, COSTr[kind]]); if (r2 === COSTr[kind]) await kv(['EXPIRE', tk.key, TW]); } catch {} }
  if (KV_URL && KV_TOKEN) await Promise.all([stat('tok', COSTr[kind]), stat('tm:ai-' + kind, COSTr[kind]), stat('tf:ai', COSTr[kind]), stat('ai_' + kind)]);

  return J({ ok: true, kind, id });
}
