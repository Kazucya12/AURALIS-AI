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

function pickModel(m) {
  if (GW_IDS.has(m)) return m;      // ID Dattio langsung
  return MAP[m] || DEFAULT_GW_MODEL; // dropdown lama / "auto" / tidak dikenal -> default
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
    'access-control-allow-headers': 'content-type',
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
  if (body.max_tokens) body.max_tokens = Math.min(+body.max_tokens || 4096, 4096);
  body.model = pickModel(b.model);

  let r;
  try {
    r = await fetch(GW_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gwKey },
      body: JSON.stringify(body),
    });
  } catch { return J({ error: { message: 'Gateway tidak bisa dihubungi' } }, 502); }

  const convert = an && r.ok && r.body;
  return new Response(convert ? toAnthropicStream(r.body) : r.body, {
    status: r.status,
    headers: { ...cors, 'content-type': convert ? 'text/event-stream' : (r.headers.get('content-type') || 'text/event-stream'), 'cache-control': 'no-store' },
  });
}
