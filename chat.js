// Vercel Edge Function: proxy aman. API key hanya dibaca dari environment variable server.
export const config = { runtime: 'edge' };

const P = { // penyedia: [endpoint, nama env var]
  qwen: ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', 'QWEN_API_KEY'],
  anthropic: ['https://api.anthropic.com/v1/messages', 'ANTHROPIC_API_KEY'],
  openai: ['https://api.openai.com/v1/chat/completions', 'OPENAI_API_KEY'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'GEMINI_API_KEY'],
  deepseek: ['https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'],
  groq: ['https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY'],
  mistral: ['https://api.mistral.ai/v1/chat/completions', 'MISTRAL_API_KEY'],
  xai: ['https://api.x.ai/v1/chat/completions', 'XAI_API_KEY'],
  openrouter: ['https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_KEY'],
};

// Hanya model di daftar ini yang boleh dipanggil (mencegah penyalahgunaan model mahal).
const MODELS = {
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus'],
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

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ok) return J({ error: { message: 'Origin tidak diizinkan' } }, 403);
  if (req.method === 'GET') return J(Object.fromEntries(Object.entries(P).map(([k, v]) => [k, !!process.env[v[1]]])));
  if (req.method !== 'POST') return J({ error: { message: 'Method tidak didukung' } }, 405);
  if (+req.headers.get('content-length') > 3e6) return J({ error: { message: 'Lampiran terlalu besar' } }, 413);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const now = Date.now(), LIM = +process.env.RATE_LIMIT || 30, WIN = 10 * 60e3;
  const a = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (a.length >= LIM) return J({ error: { message: 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.' } }, 429);
  a.push(now); hits.set(ip, a);

  let d; try { d = await req.json(); } catch { return J({ error: { message: 'Body tidak valid' } }, 400); }
  const pv = P[d.p], b = d.body;
  if (!pv || !b || !(MODELS[d.p] || []).includes(b.model)) return J({ error: { message: 'Model tidak diizinkan' } }, 400);
  const key = process.env[pv[1]];
  if (!key) return J({ error: { message: 'Penyedia ini belum dikonfigurasi di server' } }, 503);

  const an = d.p === 'anthropic';
  const body = { ...b, stream: true };
  if (an || body.max_tokens) body.max_tokens = Math.min(+body.max_tokens || 4096, 4096);
  const headers = { 'content-type': 'application/json' };
  if (an) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else headers.authorization = 'Bearer ' + key;

  let r;
  try { r = await fetch(pv[0], { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { return J({ error: { message: 'Penyedia tidak bisa dihubungi' } }, 502); }
  return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-store' } });
}
