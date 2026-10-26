// AURALIS AI — Cloudflare Workers AI gateway
// File: api/ai.js
// Required Vercel Environment Variables:
// CF_ACCOUNT_ID, CF_API_TOKEN
// Optional:
// CF_TEXT_MODEL, CF_IMAGE_MODEL, CF_EDIT_MODEL, CF_IMAGE_STEPS, ALLOWED_ORIGINS
//
// Security: never return API tokens or Authorization headers to the browser.

export const config = { runtime: 'edge' };

const ACC = (process.env.CF_ACCOUNT_ID || '').trim();
const TOKEN = (process.env.CF_API_TOKEN || '').trim();

const MODEL_TEXT = (
  process.env.CF_TEXT_MODEL ||
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
).trim();

const MODEL_IMG = (
  process.env.CF_IMAGE_MODEL ||
  '@cf/black-forest-labs/flux-1-schnell'
).trim();

const EDIT_MODEL = (
  process.env.CF_EDIT_MODEL ||
  '@cf/runwayml/stable-diffusion-v1-5-img2img'
).trim();

const STEPS = Math.min(8, Math.max(1, Number(process.env.CF_IMAGE_STEPS) || 4));
const READY = Boolean(ACC && TOKEN);
const enc = new TextEncoder();

const STY = [
  [/chibi/i, 'chibi style, cute, big head, small body, anime, 2d illustration, vibrant colors, clean line art'],
  [/anime|manga|ghibli/i, 'anime style, cel shading, vibrant colors, clean line art, detailed eyes'],
  [/kartun|cartoon/i, 'cartoon style, bold outlines, flat colors'],
  [/pixar|3d/i, '3D render, soft lighting, detailed materials'],
  [/pixel/i, 'pixel art, 16-bit, retro game sprite'],
  [/cat air|watercolou?r/i, 'watercolor painting, soft washes, paper texture'],
  [/sketsa|pensil|sketch|pencil/i, 'pencil sketch, detailed shading, monochrome'],
  [/lukisan|minyak|painting/i, 'oil painting, brush strokes, rich colors'],
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function error(message, status = 400, code) {
  const detail = { message };
  if (code) detail.code = code;
  return json({ error: detail }, status);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function imageEditBody(prompt, imageBytes, strength) {
  const style = STY.find(([regex]) => regex.test(prompt));
  return {
    prompt: prompt + (style ? ', ' + style[1] : '') +
      ', masterpiece, best quality, highly detailed',
    negative_prompt: 'lowres, blurry, watermark, deformed, extra fingers, nsfw',
    strength: Number.isFinite(strength) && strength > 0
      ? Math.min(0.95, Math.max(0.2, strength))
      : 0.6,
    num_steps: 20,
    guidance: 7.5,
    image: Array.from(imageBytes),
  };
}

async function cloudflareRun(model, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACC)}/ai/run/${model}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      const raw = await response.text();
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}

      const messages = Array.isArray(parsed.errors)
        ? parsed.errors.map(item => item.message).filter(Boolean).join('; ')
        : '';

      // Runtime Logs only: never log TOKEN or request headers.
      console.error('[AURALIS Cloudflare error]', {
        status: response.status,
        model,
        errors: parsed.errors || [],
        messages: parsed.messages || [],
      });

      return {
        ok: false,
        status: response.status,
        message: messages || 'Cloudflare Workers AI menolak permintaan.',
      };
    }

    if (contentType.startsWith('image/')) {
      return {
        ok: true,
        status: response.status,
        mime: contentType.split(';')[0],
        imageBase64: toBase64(await response.arrayBuffer()),
      };
    }

    const parsed = await response.json().catch(() => ({}));
    if (parsed.success === false) {
      const message = Array.isArray(parsed.errors)
        ? parsed.errors.map(item => item.message).filter(Boolean).join('; ')
        : 'Cloudflare mengembalikan kegagalan.';
      console.error('[AURALIS Cloudflare result error]', {
        status: response.status,
        model,
        errors: parsed.errors || [],
      });
      return { ok: false, status: response.status, message };
    }

    return { ok: true, status: response.status, result: parsed.result || parsed };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    console.error('[AURALIS Cloudflare request error]', {
      model,
      message: timedOut ? 'Request timeout' : String(err),
    });
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      message: timedOut
        ? 'Cloudflare timeout: model terlalu lama merespons.'
        : 'Tidak bisa menghubungi Cloudflare Workers AI.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeProviderError(result) {
  if (result.status === 401) {
    return error(
      'Autentikasi Cloudflare gagal. Periksa CF_API_TOKEN dan CF_ACCOUNT_ID.',
      502,
      'cloudflare_auth'
    );
  }
  if (result.status === 403) {
    return error(
      'Cloudflare menolak izin atau akses model. Periksa izin Workers AI Read/Edit dan akses model.',
      502,
      'cloudflare_permission'
    );
  }
  if (result.status === 429) {
    return error(
      'Permintaan dibatasi Cloudflare. Periksa kuota dan coba lagi nanti.',
      429,
      'cloudflare_rate_limit'
    );
  }
  if (result.status === 504) {
    return error(result.message, 504, 'cloudflare_timeout');
  }
  if (result.status === 400) {
    return error(
      result.message || 'Permintaan ditolak. Periksa model dan format input.',
      400,
      'cloudflare_bad_request'
    );
  }
  return error(
    result.message || 'Penyedia AI gagal memproses permintaan.',
    502,
    'cloudflare_upstream'
  );
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const ownOrigin = new URL(req.url).origin;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const originAllowed =
    !origin || origin === ownOrigin || allowedOrigins.includes(origin);

  const cors = {
    'access-control-allow-origin': originAllowed && origin ? origin : ownOrigin,
    'access-control-allow-headers': 'content-type,x-license',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-expose-headers': 'x-request-id',
    vary: 'origin',
  };

  const reply = (data, status = 200) => json(data, status, cors);
  const fail = (message, status = 400, code) => {
    const detail = { message };
    if (code) detail.code = code;
    return reply({ error: detail }, status);
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!originAllowed) {
    return fail('Origin tidak diizinkan.', 403, 'origin_denied');
  }

  // Health/status check. Does not reveal secrets.
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('health') === '1') {
      return reply({
        ok: true,
        gatewayConfigured: READY,
        textModel: MODEL_TEXT,
        imageModel: MODEL_IMG,
        editModel: EDIT_MODEL,
      });
    }
    return reply({
      enabled: READY,
      text: READY,
      image: READY,
      edit: READY,
    });
  }

  if (req.method !== 'POST') {
    return fail('Metode tidak didukung.', 405, 'method_not_allowed');
  }

  if (!READY) {
    return fail(
      'Gateway belum diatur. Periksa CF_ACCOUNT_ID dan CF_API_TOKEN pada Vercel Environment Variables.',
      503,
      'gateway_not_configured'
    );
  }

  const length = Number(req.headers.get('content-length') || 0);
  if (length > 1_600_000) {
    return fail('Permintaan terlalu besar.', 413, 'payload_too_large');
  }

  const data = await req.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    return fail('Body JSON tidak valid.', 400, 'invalid_json');
  }

  const kind = ['text', 'chat'].includes(data.kind)
    ? 'text'
    : data.kind === 'edit'
      ? 'edit'
      : 'image';

  const prompt = String(data.prompt || '').trim().slice(0, 4000);

  if (kind === 'text' && !prompt &&
      !(Array.isArray(data.messages) && data.messages.length)) {
    return fail('Tulis pesan terlebih dahulu.', 400, 'empty_prompt');
  }

  if (kind !== 'text' && prompt.length < 3) {
    return fail('Tulis deskripsi gambar minimal 3 karakter.', 400, 'empty_prompt');
  }

  if (kind === 'text') {
    const messages = Array.isArray(data.messages) && data.messages.length
      ? data.messages
      : [{ role: 'user', content: prompt }];

    const result = await cloudflareRun(MODEL_TEXT, {
      messages,
      max_tokens: Math.min(Math.max(Number(data.max_tokens) || 1024, 1), 2048),
    });

    if (!result.ok) return safeProviderError(result);

    const answer =
      result.result?.response ||
      result.result?.text ||
      '';

    if (typeof answer !== 'string' || !answer.trim()) {
      console.error('[AURALIS empty text response]', {
        model: MODEL_TEXT,
        responseKeys: Object.keys(result.result || {}),
      });
      return fail(
        'Cloudflare tidak mengembalikan teks. Periksa model yang dipilih.',
        502,
        'empty_ai_response'
      );
    }

    return reply({ ok: true, kind: 'text', response: answer });
  }

  if (kind === 'image') {
    const result = await cloudflareRun(MODEL_IMG, {
      prompt: prompt + ', high quality, detailed composition',
      steps: STEPS,
    });

    if (!result.ok) return safeProviderError(result);

    let imageBase64 = result.imageBase64 || '';
    let mime = result.mime || 'image/png';

    if (!imageBase64 && result.result?.image) {
      imageBase64 = result.result.image;
    }

    if (!imageBase64) {
      console.error('[AURALIS empty image response]', {
        model: MODEL_IMG,
        resultKeys: Object.keys(result.result || {}),
      });
      return fail(
        'Model tidak mengembalikan gambar. Periksa dukungan model dan format respons.',
        502,
        'empty_image_response'
      );
    }

    return reply({
      ok: true,
      kind: 'image',
      img: `data:${mime};base64,${imageBase64}`,
    });
  }

  // Image edit
  const imageData = String(data.image || '');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(imageData);

  if (!match || imageData.length > 1_400_000) {
    return fail(
      'Gambar edit tidak valid atau terlalu besar. Gunakan JPEG, PNG, atau WebP.',
      400,
      'invalid_image'
    );
  }

  let imageBytes;
  try {
    const binary = atob(match[2]);
    imageBytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return fail('Data gambar tidak bisa dibaca.', 400, 'invalid_image_data');
  }

  const result = await cloudflareRun(
    EDIT_MODEL,
    imageEditBody(prompt, imageBytes, Number(data.strength))
  );

  if (!result.ok) return safeProviderError(result);

  let imageBase64 = result.imageBase64 || result.result?.image || '';
  const mime = result.mime || 'image/png';

  if (!imageBase64) {
    console.error('[AURALIS empty edit response]', {
      model: EDIT_MODEL,
      resultKeys: Object.keys(result.result || {}),
    });
    return fail(
      'Model edit tidak mengembalikan gambar. Model mungkin tidak mendukung format input ini.',
      502,
      'empty_edit_response'
    );
  }

  return reply({
    ok: true,
    kind: 'edit',
    img: `data:${mime};base64,${imageBase64}`,
  });
}
