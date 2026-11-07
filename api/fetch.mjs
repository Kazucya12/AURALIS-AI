// api/fetch.mjs - membaca isi halaman web publik lalu mengembalikannya sebagai teks bersih.
// GET /api/fetch            -> {enabled:true}
// GET /api/fetch?u=<url>    -> {url, title, desc, text, type, truncated}
// Memakai ESM (.mjs) supaya jalan di Vercel apa pun isi "type" di package.json.
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 1_500_000;   // batas unduhan per halaman
const MAX_TEXT = 24_000;       // batas teks yang dikembalikan
const TIMEOUT = 9000;
const MAX_REDIR = 4;
const UA = 'Mozilla/5.0 (compatible; AuralisBot/1.0; +https://auralis-ai-nine.vercel.app)';

// pembatas laju sederhana per IP (per instance; cukup untuk meredam penyalahgunaan ringan)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const r = w.filter(t => now - t < 60_000);
  r.push(now); hits.set(ip, r);
  if (hits.size > 500) hits.delete(hits.keys().next().value);
  return r.length > 40;
}

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Tautan tidak valid'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Hanya http dan https');
  if (u.username || u.password) throw new Error('Tautan berisi kredensial');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error('Port tidak diizinkan');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Alamat internal diblokir');
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error('Alamat internal diblokir');
  } else {
    const rs = await dns.lookup(host, { all: true });
    if (!rs.length || rs.some(r => privateIp(r.address))) throw new Error('Alamat internal diblokir');
  }
  return u;
}

async function get(url, signal) {
  let u = await safeUrl(url);
  for (let i = 0; i <= MAX_REDIR; i++) {
    const r = await fetch(u, {
      redirect: 'manual', signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'id,en;q=0.8' }
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      u = await safeUrl(new URL(r.headers.get('location'), u).href);
      continue;
    }
    return { r, u };
  }
  throw new Error('Terlalu banyak pengalihan');
}

async function readBody(r) {
  const rd = r.body.getReader(); const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length; parts.push(value);
    if (n > MAX_BYTES) { try { await rd.cancel(); } catch {} break; }
  }
  const buf = Buffer.concat(parts);
  const ct = r.headers.get('content-type') || '';
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const m = buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i); cs = m && m[1]; }
  try { return { text: new TextDecoder(cs || 'utf-8').decode(buf), cut: n > MAX_BYTES }; }
  catch { return { text: buf.toString('utf8'), cut: n > MAX_BYTES }; }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
const unent = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch { return ' '; } }
  return ENT[e.toLowerCase()] ?? m;
});
const meta = (h, n) => {
  const m = h.match(new RegExp('<meta[^>]+(?:name|property)=["\']' + n + '["\'][^>]*>', 'i'));
  const c = m && m[0].match(/content=["']([^"']*)["']/i);
  return c ? unent(c[1]).trim() : '';
};

function htmlToText(h) {
  const title = unent((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).replace(/\s+/g, ' ').trim();
  const desc = meta(h, 'description') || meta(h, 'og:description');
  let b = h.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|template)[\s\S]*?<\/\1>/gi, ' ');
  // utamakan <main> / <article> bila ada
  const main = b.match(/<main[\s\S]*?<\/main>/i) || b.match(/<article[\s\S]*?<\/article>/i);
  if (main && main[0].length > 600) b = main[0];
  else b = b.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  b = b.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => '\n\n' + '#'.repeat(Math.min(+l, 4)) + ' ' + t.replace(/<[^>]+>/g, '') + '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  b = unent(b).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, desc, text: b };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-license,x-uid');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const q = req.query || {};
  if (!q.u) return res.status(200).json({ enabled: true });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limited(ip)) return res.status(429).json({ error: { message: 'Terlalu banyak permintaan, coba sebentar lagi.' } });
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const { r, u } = await get(String(q.u).slice(0, 2000), ac.signal);
    if (!r.ok) return res.status(200).json({ url: u.href, error: { message: 'Situs membalas ' + r.status } });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (/pdf|image\/|video\/|audio\/|zip|octet-stream/.test(ct)) return res.status(200).json({ url: u.href, type: ct, title: '', text: '', error: { message: 'Jenis berkas ini (' + ct.split(';')[0] + ') tidak bisa dibaca sebagai teks.' } });
    const { text, cut } = await readBody(r);
    let out;
    if (/json|text\/plain|xml|markdown/.test(ct) && !/html/.test(ct)) out = { title: '', desc: '', text: text.trim() };
    else out = htmlToText(text);
    const max = Math.min(MAX_TEXT, Math.max(1000, parseInt(q.max, 10) || 12000));
    res.status(200).json({ url: u.href, type: ct.split(';')[0], title: out.title.slice(0, 200), desc: out.desc.slice(0, 400), text: out.text.slice(0, max), truncated: cut || out.text.length > max });
  } catch (e) {
    const m = e.name === 'AbortError' ? 'Situs terlalu lama merespons' : e.message || 'Gagal membaca halaman';
    res.status(200).json({ error: { message: m } });
  } finally { clearTimeout(tm); }
}
