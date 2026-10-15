// Vercel Edge Function: proxy aman. API key hanya dibaca dari environment variable server.
// Jika key provider asli kosong, request otomatis dialihkan lewat gateway (QWEN_BASE_URL + QWEN_API_KEY).
export const config = { runtime: 'edge' };

const P = { // penyedia: [endpoint, nama env var]
  qwen: [((process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')) + '/chat/completions', 'QWEN_API_KEY'],
  anthropic: ['https://api.anthropic.com/v1/messages', 'ANTHROPIC_API_KEY'],
  openai: ['https://api.openai.com/v1/chat/completions', 'OPENAI_API_KEY'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'GEMINI_API_KEY'],
  deepseek: ['https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'],
  groq: ['https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY'],
  mistral: ['https://api.mistral.ai/v1/chat/completions', 'MISTRAL_API_KEY'],
  xai: ['https://api.x.ai/v1/chat/completions', 'XAI_API_KEY'],
  openrouter: ['https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_KEY'],
};

const EXTRA = (process.env.QWEN_EXTRA_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);

// Hanya model di daftar ini yang boleh dipanggil (mencegah penyalahgunaan model mahal).
const MODELS = {
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus', ...EXTRA],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  groq: ['llama-3.3-70b-versatile'],
  mistral: ['mistral-large-latest'],
  xai: ['grok-4'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
};

const hits = new Map(); // rate limit per IP (per instance)

// Format Anthropic -> format OpenAI (untuk gateway)
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

// Stream OpenAI -> stream gaya Anthropic (supaya frontend lama tetap jalan)
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

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return J({ error: { message: 'Origin tidak diizinkan' } }, 403);
  if (req.method === 'GET') {
    return J(Object.fromEntries(Object.entries(P).map(([k, v]) => [
      k,
      !!(process.env[v[1]] || '').trim() || (!!gwKey && k !== 'openrouter'),
    ])));
  }
  if (req.method !== 'POST') return J({ error: { message: 'Method tidak didukung' } }, 405);
  if (+req.headers.get('content-length') > 3e6) return J({ error: { message: 'Lampiran terlalu besar' } }, 413);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const now = Date.now(), LIM = +process.env.RATE_LIMIT || 30, WIN = 10 * 60e3;
  const a = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return J({ error: { message: 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.' } }, 429);
  a.push(now); hits.set(ip, a);

  let d; try { d = await req.json(); } catch { return J({ error: { message: 'Body tidak valid' } }, 400); }
  const pv = P[d.p], b = d.body;
  if (!pv || !b) return J({ error: { message: 'Model tidak diizinkan' } }, 400);

  const ownKey = (process.env[pv[1]] || '').trim();
  const viaGw = !ownKey && !!gwKey && d.p !== 'qwen' && d.p !== 'openrouter';

  const allowed = (MODELS[d.p] || []).includes(b.model) || (viaGw && EXTRA.includes(b.model));
  if (!allowed) return J({ error: { message: 'Model tidak diizinkan' } }, 400);

  const key = viaGw ? gwKey : ownKey;
  if (!key) return J({ error: { message: 'Penyedia ini belum dikonfigurasi di server' } }, 503);

  const an = d.p === 'anthropic';
  const url = viaGw ? P.qwen[0] : pv[0];

  let body, headers = { 'content-type': 'application/json' };
  if (an && !viaGw) {
    body = { ...b, stream: true };
    body.max_tokens = Math.min(+body.max_tokens || 4096, 4096);
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
  } else {
    body = an ? toOpenAI(b) : { ...b, stream: true };
    if (body.max_tokens) body.max_tokens = Math.min(+body.max_tokens || 4096, 4096);
    headers.authorization = 'Bearer ' + key;
  }
const gm = (process.env.GATEWAY_MODEL || '').trim();
if (gm && (viaGw || d.p === 'qwen')) body.model = gm;
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { return J({ error: { message: 'Penyedia tidak bisa dihubungi' } }, 502); }

  const convert = an && viaGw && r.ok && r.body;
  return new Response(convert ? toAnthropicStream(r.body) : r.body, {
    status: r.status,
    headers: { ...cors, 'content-type': convert ? 'text/event-stream' : (r.headers.get('content-type') || 'text/event-stream'), 'cache-control': 'no-store' },
  });
}
