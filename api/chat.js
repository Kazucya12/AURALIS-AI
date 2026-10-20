// Vercel Edge Function: proxy khusus gateway Dattio.
// Env yang dipakai: QWEN_API_KEY (wajib), QWEN_BASE_URL (URL gateway), GATEWAY_MODEL (opsional, default model),
// QWEN_EXTRA_MODELS (opsional), ALLOWED_ORIGINS (opsional), RATE_LIMIT (opsional).
export const config = { runtime: 'edge' };

const GW_URL = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
  .trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';

const EXTRA = (process.env.QWEN_EXTRA_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_GW_MODEL = (process.env.GATEWAY_MODEL || '').trim() || 'glm-5.3';

// Nama di dropdown -> model Dattio
const MAP = {
  'qwen-plus': 'glm-5.3', 'qwen-max': 'deepseek-v4-pro', 'qwen-turbo': 'glm-5.3-flash', 'qwen-vl-plus': 'deepseek-v4-flash-vision-exp',
  'claude-opus-5-5': 'claude-opus-5-5', 'claude-sonnet-5-5': 'claude-sonnet-5-5', 'claude-haiku-5-5': 'claude-sonnet-5-5',
  'gpt-5': 'gpt-5.6', 'gpt-5-mini': 'gpt-5.6-luna', 'gpt-4o': 'gpt-5.6', 'gpt-4o-mini': 'gpt-5.6-luna',
  'gemini-2.5-pro': 'glm-5.3', 'gemini-2.5-flash': 'glm-5.3-flash',
  'deepseek-chat': 'deepseek-v4-flash', 'deepseek-reasoner': 'deepseek-v4-pro',
  'llama-3.3-70b-versatile': 'glm-5.3-flash', 'mistral-large-latest': 'glm-5.3', 'grok-4': 'kimi-k3',
};
const GW_IDS = new Set([...Object.values(MAP), ...EXTRA]);

// Daftar model asli dari gateway (di-cache 10 menit), supaya model baru (mis. GPT Argon) langsung bisa dipakai tanpa ubah kode
let MC = { t: 0, ids: [] };
async function gwModels(gwKey) {
  if (Date.now() - MC.t < 6e5 && MC.ids.length) return MC.ids;
  try {
    const r = await fetch(GW_URL.replace(/\/chat\/completions$/, '') + '/models', { headers: { authorization: 'Bearer ' + gwKey } });
    const j = await r.json();
    const ids = (j.data || j.models || []).map(x => (typeof x === 'string' ? x : x && x.id)).filter(x => typeof x === 'string' && x.length < 80);
    if (ids.length) MC = { t: Date.now(), ids };
  } catch {}
  return MC.ids;
}
async function pickModel(m, gwKey) {
  if (GW_IDS.has(m)) return { id: m, dyn: false };      // ID Dattio langsung
  if (MAP[m]) return { id: MAP[m], dyn: false };
  if (typeof m === 'string' && m && (await gwModels(gwKey)).includes(m)) return { id: m, dyn: true }; // model baru dari gateway
  return { id: DEFAULT_GW_MODEL, dyn: false };           // "auto" / tidak dikenal -> default
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
async function isPro(req) {
  if (!PRO_SECRET) return true;
  return !!(await licInfo(req));
}
const PRO_ERR = { error: { message: 'Fitur ini khusus Pro. Buka menu Atur > Langganan untuk upgrade.', code: 'pro_required' } };

const PRO_MODELS = new Set((process.env.PRO_MODELS || 'claude-opus-5-5,claude-sonnet-5-5,gpt-5.6,gpt-5.6-luna,kimi-k3').split(',').map(s => s.trim()).filter(Boolean));

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
async function kvCmd(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv');
  return (await r.json()).result;
}
// Batas token per 6 jam (perkiraan: 1 token per 4 karakter). Pro dihitung per lisensi, Gratis per IP.
const TOK_FREE = +process.env.TOKEN_LIMIT_FREE || 15000, TOK_PRO = +process.env.TOKEN_LIMIT_PRO || 50000, TOK_WIN = 6 * 3600;
const estTok = s => Math.ceil(String(s || '').length / 4);
async function tokState(req, ip) {
  if (!PRO_SECRET || !KV_URL || !KV_TOKEN) return null;
  try {
    const lic = await licInfo(req), who = lic ? 'L' + String(lic.c || lic.e) : 'I' + ip;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', _enc.encode(who)));
    const key = 'auralis:tk:' + [...h.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join('');
    const limit = lic ? TOK_PRO : TOK_FREE;
    const used = +(await kvCmd(['GET', key])) || 0;
    const ttl = used ? await kvCmd(['PTTL', key]) : -2;
    return { key, limit, used, reset: ttl > 0 ? ttl : TOK_WIN * 1000 };
  } catch { return null; }
}
async function tokAdd(st, n) {
  if (!st || !(n > 0)) return;
  try {
    const r = await kvCmd(['INCRBY', st.key, Math.round(n)]);
    if (r === Math.round(n)) await kvCmd(['EXPIRE', st.key, TOK_WIN]);
  } catch {}
}
function countStream(src, st) {
  const dec = new TextDecoder(); let carry = '', chars = 0, pend = 0;
  const re = /"(?:content|reasoning_content|reasoning)":"((?:[^"\\]|\\.)*)"/g;
  return src.pipeThrough(new TransformStream({
    async transform(chunk, ctl) {
      ctl.enqueue(chunk);
      const t = carry + dec.decode(chunk, { stream: true }), cut = t.lastIndexOf('\n');
      const use = cut >= 0 ? t.slice(0, cut) : ''; carry = cut >= 0 ? t.slice(cut + 1) : t;
      let m; re.lastIndex = 0; while ((m = re.exec(use))) chars += m[1].length;
      if (chars - pend > 4000) { const d = chars - pend; pend = chars; await tokAdd(st, d / 4); }
    },
    async flush() { if (carry) { let m; re.lastIndex = 0; while ((m = re.exec(carry))) chars += m[1].length; } await tokAdd(st, (chars - pend) / 4); },
  }));
}
const hits = new Map();
function limited(ip) {
  const now = Date.now(), LIM = +process.env.RATE_LIMIT || 30, WIN = 10 * 60e3;
  const a = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return true;
  a.push(now); hits.set(ip, a);
  return false;
}

function toOpenAI(b) {
  const msgs = [];
  if (b.system) msgs.push({ role: 'system', content: typeof b.system === 'string' ? b.system : b.system.map(x => x.text || '').join('\n') });
  for (const m of b.messages || []) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    msgs.push({
      role: m.role,
      content: (m.content || []).map(c => c.type === 'image' && c.source
        ? { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }
        : { type: 'text', text: c.text || '' }),
    });
  }
  return { model: b.model, messages: msgs, max_tokens: b.max_tokens, temperature: b.temperature, stream: true };
}

function toAnthropicStream(src) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const ev = (t, o) => enc.encode(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`);
  return src.pipeThrough(new TransformStream({
    start(c) {
      c.enqueue(ev('message_start', { message: { role: 'assistant', content: [] } }));
      c.enqueue(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    },
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        const s = l.slice(5).trim();
        if (!s || s === '[DONE]') continue;
        try {
          const t = JSON.parse(s).choices?.[0]?.delta?.content;
          if (t) c.enqueue(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }));
        } catch {}
      }
    },
    flush(c) {
      c.enqueue(ev('content_block_stop', { index: 0 }));
      c.enqueue(ev('message_stop', {}));
    },
  }));
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const own = new URL(req.url).origin;
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || origin === own || allow.includes(origin);
  const cors = {
    'access-control-allow-origin': ok && origin ? origin : own,
    'access-control-allow-headers': 'content-type,x-license',
    'access-control-expose-headers': 'x-tok-used,x-tok-limit,x-tok-reset',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    vary: 'origin',
  };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json' } });

  const gwKey = (process.env.QWEN_API_KEY || '').trim();
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return J({ error: { message: 'Origin tidak diizinkan' } }, 403);

  if (req.method === 'GET') {
    const u = new URL(req.url);
    if (u.searchParams.get('debug') === '1') {
      if (limited(ip)) return J({ error: 'Terlalu banyak permintaan' }, 429);
      if (!gwKey) return J({ error: 'QWEN_API_KEY kosong di server' });
      const out = { gateway_url: GW_URL, default_model: DEFAULT_GW_MODEL, extra_models: EXTRA };
      const auth = { authorization: 'Bearer ' + gwKey };
      try {
        const m = await fetch(GW_URL.replace(/\/chat\/completions$/, '') + '/models', { headers: auth });
        const t = await m.text();
        out.models_status = m.status;
        try { out.models = JSON.parse(t).data.map(x => x.id); } catch { out.models_raw = t.slice(0, 300); }
      } catch (e) { out.models_error = String(e); }
      const model = u.searchParams.get('model') || DEFAULT_GW_MODEL;
      try {
        const c = await fetch(GW_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'halo' }], max_tokens: 20 }),
        });
        out.test_model = model; out.test_status = c.status; out.test_reply = (await c.text()).slice(0, 400);
      } catch (e) { out.test_error = String(e); }
      return J(out);
    }
    if (u.searchParams.get('usage') === '1') {
      if (limited(ip)) return J({ error: 'Terlalu banyak permintaan' }, 429);
      const st = await tokState(req, ip);
      return J(st ? { on: true, used: st.used, limit: st.limit, reset: st.reset } : { on: false });
    }
    if (u.searchParams.get('models') === '1') {
      return J({ models: gwKey ? await gwModels(gwKey) : [] });
    }
    // Status ketersediaan: semua penyedia aktif selama key gateway ada
    const names = ['qwen', 'anthropic', 'openai', 'gemini', 'deepseek', 'groq', 'mistral', 'xai', 'openrouter'];
    return J(Object.fromEntries(names.map(k => [k, !!gwKey])));
  }

  if (req.method !== 'POST') return J({ error: { message: 'Method tidak didukung' } }, 405);
  if (+req.headers.get('content-length') > 3e6) return J({ error: { message: 'Lampiran terlalu besar' } }, 413);
  if (limited(ip)) return J({ error: { message: 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.' } }, 429);
  if (!gwKey) return J({ error: { message: 'QWEN_API_KEY belum diatur di server' } }, 503);

  let d; try { d = await req.json(); } catch { return J({ error: { message: 'Body tidak valid' } }, 400); }
  const b = d && d.body;
  if (!b || !Array.isArray(b.messages)) return J({ error: { message: 'Body tidak valid' } }, 400);

  const an = d.p === 'anthropic';
  const body = an ? toOpenAI(b) : { ...b, stream: true };
  // Upaya AI: reasoning_effort hanya low/medium/high; 'high' dan token besar khusus Pro
  const wantPro = body.reasoning_effort === 'high' || +body.max_tokens > 4096;
  const proUser = wantPro ? await isPro(req) : true;
  if (!['low', 'medium', 'high'].includes(body.reasoning_effort) || (body.reasoning_effort === 'high' && !proUser)) delete body.reasoning_effort;
  if (body.max_tokens) body.max_tokens = Math.min(+body.max_tokens || 4096, proUser ? 8192 : 4096);
  const pm = await pickModel(b.model, gwKey);
  body.model = pm.id;
  // model baru dari gateway yang belum ada di daftar bawaan dianggap Pro (biaya tidak diketahui); bebaskan lewat env FREE_MODELS
  const FREE_M = (process.env.FREE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const needPro = PRO_MODELS.has(body.model) || (pm.dyn && !FREE_M.includes(body.model));
  if (needPro && !(await isPro(req))) return J({ error: { message: 'Model ini khusus Pro. Buka menu Atur > Langganan untuk upgrade.', code: 'pro_required' } }, 402);

  const tk = await tokState(req, ip);
  if (tk && tk.used >= tk.limit) {
    const mnt = Math.ceil(tk.reset / 60000);
    return J({ error: { message: 'Batas ' + tk.limit.toLocaleString('id-ID') + ' token tercapai. Reset dalam ' + Math.floor(mnt / 60) + ' jam ' + (mnt % 60) + ' menit.', code: 'quota' }, used: tk.used, limit: tk.limit, reset: tk.reset }, 429);
  }
  const inTok = estTok(JSON.stringify(b.messages).replace(/data:[^"]{200,}/g, 'x')) + (JSON.stringify(b.messages).includes('image_url') ? 800 : 0);

  let r;
  const callGw = () => fetch(GW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gwKey },
    body: JSON.stringify(body),
  });
  try {
    r = await callGw();
    // Beberapa model menolak parameter upaya: coba lagi tanpa reasoning_effort, lalu tanpa max_tokens
    if (r.status === 400 && body.reasoning_effort) { delete body.reasoning_effort; r = await callGw(); }
    if (r.status === 400 && b.max_tokens && body.max_tokens) { delete body.max_tokens; r = await callGw(); }
  } catch { return J({ error: { message: 'Gateway tidak bisa dihubungi' } }, 502); }

  let src = r.body;
  const extra = {};
  if (tk && r.ok && src) { await tokAdd(tk, inTok); src = countStream(src, tk); extra['x-tok-used'] = String(tk.used + inTok); extra['x-tok-limit'] = String(tk.limit); extra['x-tok-reset'] = String(tk.reset); }
  const convert = an && r.ok && src;
  return new Response(convert ? toAnthropicStream(src) : src, {
    status: r.status,
    headers: { ...cors, ...extra, 'content-type': convert ? 'text/event-stream' : (r.headers.get('content-type') || 'text/event-stream'), 'cache-control': 'no-store' },
  });
}
