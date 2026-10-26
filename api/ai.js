// Vercel Edge Function: Auralis Ultimate AI Gateway
// Mendukung: Teks (dengan Memori & Streaming), Vision, Generator Gambar, Edit Foto, dan Audio (STT).
export const config = { runtime: 'edge' };

const ACC = (process.env.CF_ACCOUNT_ID || '').trim();
const TOKEN = (process.env.CF_API_TOKEN || '').trim();

// Definisi Model Cloudflare
const M_TEXT = (process.env.CF_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8').trim();
const M_VISION = (process.env.CF_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct').trim();
const M_AUDIO = (process.env.CF_AUDIO_MODEL || '@cf/openai/whisper').trim();
const M_IMG = (process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell').trim();
const M_EDIT = (process.env.CF_EDIT_MODEL || '@cf/runwayml/stable-diffusion-v1-5-img2img').trim();

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  return r.ok ? (await r.json()).result : null;
}

const toB64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').split(',').pop()), c => c.charCodeAt(0));

export default async function handler(req) {
  const origin = req.headers.get('origin') || '', own = new URL(req.url).origin;
  const cors = { 'access-control-allow-origin': origin || own, 'access-control-allow-headers': 'content-type,x-license', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'content-type': 'application/json' } });
  const E = (m, st = 400) => J({ error: { message: m } }, st);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ACC || !TOKEN) return E('Gateway belum diatur', 503);

  const d = await req.json().catch(() => null);
  if (!d) return E('Body tidak valid');

  const kind = d.kind || 'text'; // text, vision, audio, image, edit
  const prompt = String(d.prompt || '').trim();

  // 1. TEKS & CHAT (Mendukung Redis Memory & Streaming)
  if (kind === 'text' || kind === 'chat') {
    if (!prompt && !d.messages) return E('Prompt kosong');
    
    let messages = d.messages || [];
    const sessionId = d.sessionId ? `auralis:chat:${d.sessionId}` : null;

    // Ambil histori dari Redis jika ada sessionId dan messages tidak dikirim dari frontend
    if (sessionId && messages.length === 0) {
      const history = await kv(['GET', sessionId]);
      if (history) messages = JSON.parse(history);
    }

    if (prompt) messages.push({ role: 'user', content: prompt });

    const isStream = !!d.stream;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${M_TEXT}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 2048, stream: isStream }),
    });

    if (!r.ok) return E('Gagal memproses teks', 502);

    // Mode Streaming (Langsung di-pipe ke frontend)
    if (isStream) {
      return new Response(r.body, { headers: { ...cors, 'content-type': 'text/event-stream' } });
    }

    // Mode Normal (Simpan histori ke Redis)
    const resJson = await r.json();
    const answer = resJson.result?.response || '';
    
    if (sessionId) {
      messages.push({ role: 'assistant', content: answer });
      await kv(['SETEX', sessionId, 86400, JSON.stringify(messages)]); // Simpan 24 Jam
    }
    return J({ ok: true, kind: 'text', response: answer });
  }

  // 2. VISION (Analisis Gambar)
  if (kind === 'vision') {
    if (!prompt || !d.image) return E('Prompt dan image base64 wajib ada');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${M_VISION}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ image: Array.from(fromB64(d.image)), prompt }),
    });
    const res = await r.json();
    return r.ok ? J({ ok: true, response: res.result?.response }) : E('Gagal memproses Vision', 502);
  }

  // 3. AUDIO (Speech-to-Text)
  if (kind === 'audio') {
    if (!d.audio) return E('Audio base64 wajib ada');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${M_AUDIO}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ audio: Array.from(fromB64(d.audio)) }),
    });
    const res = await r.json();
    return r.ok ? J({ ok: true, text: res.result?.text }) : E('Gagal mentranskripsi audio', 502);
  }

  // 4. IMAGE & EDIT (FLUX / Img2Img)
  if (kind === 'image' || kind === 'edit') {
    let imgBytes = null, imgB64 = '';
    if (kind === 'edit') {
      if (!d.image) return E('Gambar edit tidak valid');
      imgBytes = Array.from(fromB64(d.image));
      imgB64 = d.image.split(',').pop();
    }
    
    const bodyPayload = kind === 'edit' 
      ? { prompt: prompt + ', masterpiece, best quality', image_b64: imgB64, guidance: 7.5, strength: +d.strength || 0.6 } 
      : { prompt, steps: 4 };

    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${kind === 'edit' ? M_EDIT : M_IMG}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.startsWith('image/')) {
      return J({ ok: true, kind, img: `data:${ct.split(';')[0]};base64,${toB64(await r.arrayBuffer())}` });
    }
    const p = await r.json().catch(() => ({}));
    return p.result?.image ? J({ ok: true, kind, img: `data:image/jpeg;base64,${p.result.image}` }) : E('Gagal render gambar', 502);
  }

  return E('Jenis aksi (kind) tidak dikenali');
}
