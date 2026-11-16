#!/usr/bin/env node
/**
 * Ktuvit.me subtitles addon for Stremio — zero dependencies (Node 18.14+).
 *
 * Config (environment variables):
 *   KTUVIT_EMAIL            your ktuvit.me account email
 *   KTUVIT_PASSWORD         your ktuvit.me password (hashed locally like the site's login form)
 *   KTUVIT_HASHED_PASSWORD  alternative: the already-hashed password
 *   KTUVIT_LOGIN_COOKIE     alternative to the two above: value of the "Login" cookie (u=...&g=...)
 *   ADDON_SECRET            optional; if set, the addon only answers under /<secret>/... (use when hosting publicly)
 *   RATE_LIMIT_PER_MIN      subtitle downloads allowed per client IP per minute (default 5)
 *   PORT                    default 7000
 *   PUBLIC_URL              optional, e.g. https://my-addon.example.com (otherwise taken from the request)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const KTUVIT = 'https://www.ktuvit.me';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const PORT = Number(process.env.PORT) || 7000;
const SECRET = (process.env.ADDON_SECRET || '').replace(/[^A-Za-z0-9_-]/g, '');
const PREFIX = SECRET ? `/${SECRET}` : '';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const manifest = {
  id: 'community.ktuvit.subtitles',
  version: '1.2.0',
  name: 'Ktuvit Subtitles',
  description: 'Hebrew subtitles from ktuvit.me (unofficial)',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

/* ----------------------------- tiny TTL cache ----------------------------- */

function makeCache(maxEntries) {
  const map = new Map();
  const pending = new Map(); // de-duplicate concurrent identical lookups
  return async function cached(key, ttlMs, fn, missTtlMs = 0) {
    const hit = map.get(key);
    if (hit && hit.exp > Date.now()) return hit.val;
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      const val = await fn();
      const miss = val === null || val === undefined;
      if (!miss || missTtlMs) map.set(key, { val, exp: Date.now() + (miss ? missTtlMs : ttlMs) });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
      return val;
    })().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}
const cached = makeCache(5000); // ids + subtitle lists (small)
const cachedSrt = makeCache(150); // subtitle files (~100-200 KB each)
const HOUR = 3600 * 1000;

/* ------------------------------ ktuvit client ----------------------------- */

let loginCookie = process.env.KTUVIT_LOGIN_COOKIE
  ? `Login=${process.env.KTUVIT_LOGIN_COOKIE.replace(/^Login=/, '')}`
  : null;

/**
 * Port of the site's own Encrypt() (js/Modules/LoginHandler.js, CryptoJS):
 * base64(sha256(AES-128-CBC(password, key = PBKDF2-SHA1(siteSalt, email, 3000), iv = Hex.parse(email)))).
 * The IV reproduces CryptoJS's lenient hex parsing of a non-hex string.
 */
const KTUVIT_SALT = 'C8928DC731EC4E30AE6C523A34BE353A';
function hashPassword(email, password) {
  const words = new Int32Array(4);
  for (let i = 0; i < email.length; i += 2) {
    if (i >>> 3 < 4) words[i >>> 3] |= parseInt(email.substr(i, 2), 16) << (24 - (i % 8) * 4);
  }
  const iv = Buffer.alloc(16);
  words.forEach((w, n) => iv.writeInt32BE(w, n * 4));
  const key = crypto.pbkdf2Sync(KTUVIT_SALT, email, 3000, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return crypto.createHash('sha256').update(ct).digest('base64');
}

let loginInFlight = null;
function login(force = false) {
  if (loginCookie && !force) return Promise.resolve(loginCookie);
  if (!loginInFlight) loginInFlight = doLogin().finally(() => (loginInFlight = null));
  return loginInFlight;
}
async function doLogin() {
  const { KTUVIT_EMAIL, KTUVIT_PASSWORD } = process.env;
  const KTUVIT_HASHED_PASSWORD =
    process.env.KTUVIT_HASHED_PASSWORD ||
    (KTUVIT_EMAIL && KTUVIT_PASSWORD ? hashPassword(KTUVIT_EMAIL, KTUVIT_PASSWORD) : null);
  if (!KTUVIT_EMAIL || !KTUVIT_HASHED_PASSWORD) {
    if (loginCookie) return loginCookie; // static cookie only, nothing to refresh with
    throw new Error('Set KTUVIT_EMAIL + KTUVIT_PASSWORD (or KTUVIT_LOGIN_COOKIE)');
  }
  const res = await fetch(`${KTUVIT}/Services/MembershipService.svc/Login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ request: { Email: KTUVIT_EMAIL, Password: KTUVIT_HASHED_PASSWORD } }),
  });
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const c = cookies.map((s) => s.split(';')[0]).find((s) => s.startsWith('Login='));
  if (!c) throw new Error(`Ktuvit login failed (HTTP ${res.status}) — check email / hashed password`);
  loginCookie = c;
  return c;
}

async function kFetch(path, opts = {}) {
  const cookie = await login();
  return fetch(KTUVIT + path, {
    ...opts,
    headers: { 'user-agent': UA, accept: '*/*', cookie, ...(opts.headers || {}) },
  });
}

/** POST to one of the site's .svc JSON services; they wrap the payload as {d: "<json string>"} */
async function kService(path, request) {
  const res = await kFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const body = await res.json();
  return typeof body.d === 'string' ? JSON.parse(body.d) : body.d;
}

async function searchKtuvit(name, isSeries) {
  const data = await kService('/Services/ContentProvider.svc/SearchPage_search', {
    FilmName: name,
    Actors: [],
    Studios: null,
    Directors: [],
    Genres: [],
    Countries: [],
    Languages: [],
    Year: '',
    Rating: [],
    Page: 1,
    SearchType: isSeries ? '1' : '0',
    WithSubsOnly: false,
  });
  return (data && data.Films) || [];
}

async function getTitle(type, imdbId) {
  const res = await fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`);
  if (!res.ok) return null;
  const { meta } = await res.json();
  return meta && meta.name ? meta.name : null;
}

function getKtuvitId(type, imdbId) {
  return cached(`id:${imdbId}`, 24 * HOUR, async () => {
    const name = await getTitle(type, imdbId);
    if (!name) return null;
    const films = await searchKtuvit(name, type === 'series');
    const match = films.find(
      (f) => f.ImdbID === imdbId || (f.IMDB_Link && String(f.IMDB_Link).includes(imdbId))
    );
    return match ? match.ID : null;
  }, HOUR); // remember misses for an hour too
}

/** Pull {id, name} pairs out of the subtitles table HTML. */
function parseSubsHtml(html) {
  const subs = [];
  const seen = new Set();
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const idM = row.match(/data-subtitle-id\s*=\s*["']([^"']+)["']/i);
    if (!idM || seen.has(idM[1])) continue;
    seen.add(idM[1]);
    const firstTd = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [, ''])[1];
    const name =
      firstTd
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .map((s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim())
        .find(Boolean) || idM[1];
    subs.push({ id: idM[1], name });
  }
  return subs;
}

function listSubs(ktuvitId, season, episode) {
  const path =
    season != null
      ? `/Services/GetModuleAjax.ashx?moduleName=SubtitlesList&SeriesID=${ktuvitId}&Season=${season}&Episode=${episode}`
      : `/MovieInfo.aspx?ID=${ktuvitId}`;
  return cached(`subs:${path}`, HOUR, async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await kFetch(path);
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      const html = await res.text();
      // Logged-out pages hide the table behind a "log in to view" notice.
      if (attempt === 0 && html.includes('התחבר על מנת להציג') && process.env.KTUVIT_EMAIL) {
        await login(true);
        continue;
      }
      return parseSubsHtml(html);
    }
  });
}

async function downloadSub(filmId, subId, retry = true) {
  const data = await kService('/Services/ContentProvider.svc/RequestSubtitleDownload', {
    FilmID: filmId,
    SubtitleID: subId,
    FontSize: 0,
    FontColor: '',
    PredefinedLayout: -1,
  });
  if (!data || !data.DownloadIdentifier) {
    if (retry && process.env.KTUVIT_EMAIL) {
      await login(true); // session probably expired
      return downloadSub(filmId, subId, false);
    }
    throw new Error('Ktuvit refused the download (not logged in?)');
  }
  const res = await kFetch(
    `/Services/DownloadFile.ashx?DownloadIdentifier=${encodeURIComponent(data.DownloadIdentifier)}`
  );
  if (!res.ok) throw new Error(`DownloadFile -> HTTP ${res.status}`);
  return toUtf8(Buffer.from(await res.arrayBuffer()));
}

/** Many Hebrew .srt files are windows-1255; Stremio wants UTF-8. */
function toUtf8(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(new TextDecoder('utf-16le').decode(buf));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return buf;
  } catch {
    return Buffer.from(new TextDecoder('windows-1255').decode(buf), 'utf8');
  }
}

/* --------------------------- release-name ranking -------------------------- */

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.max(1, Math.min(A.size, B.size));
}

/* ------------------------------- rate limiting ------------------------------ */

// Protects the shared ktuvit account: max subtitle downloads per client IP per minute.
const RATE = Number(process.env.RATE_LIMIT_PER_MIN) || 5;
const hits = new Map();
function allow(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.start > 60000) hits.set(ip, (h = { start: now, n: 0 }));
  if (hits.size > 20000) hits.clear();
  return ++h.n <= RATE;
}

/* ------------------------------- landing page ------------------------------ */

function landing(base) {
  const manifestUrl = `${base}${PREFIX}/manifest.json`;
  const stremioUrl = manifestUrl.replace(/^https?:/, 'stremio:');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${manifest.name}</title>
<style>body{font-family:system-ui,sans-serif;background:#14121f;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
main{max-width:30rem;padding:2rem}a.btn{display:inline-block;margin:1rem 0;padding:.9rem 2rem;border-radius:2rem;background:#7b5bf5;color:#fff;text-decoration:none;font-weight:600}
code{direction:ltr;display:block;word-break:break-all;background:#221f33;padding:.7rem;border-radius:.5rem;font-size:.85rem}p{line-height:1.6;color:#bbb}</style></head>
<body><main><h1>${manifest.name}</h1>
<p>כתוביות בעברית מ-ktuvit.me ישירות בתוך Stremio. תוסף לא רשמי.</p>
<a class="btn" href="${stremioUrl}">התקנה ב-Stremio</a>
<p>או הדביקו את הכתובת בחיפוש התוספים:</p><code>${manifestUrl}</code>
</main></body></html>`;
}

/* --------------------------------- server --------------------------------- */

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

async function handleSubtitles(req, type, id, extra) {
  const [imdbId, season, episode] = id.split(':');
  const ktuvitId = await getKtuvitId(type, imdbId);
  if (!ktuvitId) return [];
  const subs =
    type === 'series' && season && episode
      ? await listSubs(ktuvitId, Number(season), Number(episode))
      : await listSubs(ktuvitId);

  const filename = new URLSearchParams(extra || '').get('filename');
  const ranked = filename
    ? [...subs].sort((a, b) => similarity(b.name, filename) - similarity(a.name, filename))
    : subs;

  const base = baseUrl(req);
  return ranked.map((s) => ({
    id: `ktuvit-${s.id}`,
    lang: 'heb',
    label: s.name, // release name; shown by Stremio versions that support subtitle labels
    url: `${base}${PREFIX}/sub/${ktuvitId}/${s.id}.srt`,
  }));
}

const server = http.createServer(async (req, res) => {
  let { pathname } = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (PREFIX) {
      if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return send(res, 404, { error: 'not found' });
      pathname = pathname.slice(PREFIX.length) || '/';
    }

    if (pathname === '/' || pathname === '/manifest.json') {
      return pathname === '/'
        ? send(res, 200, landing(baseUrl(req)), 'text/html; charset=utf-8')
        : send(res, 200, manifest, undefined, { 'cache-control': 'public, max-age=3600' });
    }

    // /subtitles/{type}/{id}.json  or  /subtitles/{type}/{id}/{extra}.json
    let m = pathname.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/(.+?))?\.json$/);
    if (m) {
      const subtitles = await handleSubtitles(req, m[1], decodeURIComponent(m[2]), m[3] && decodeURIComponent(m[3]));
      return send(res, 200, { subtitles }, undefined, { 'cache-control': 'public, max-age=3600' });
    }

    m = pathname.match(/^\/sub\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\.srt$/);
    if (m) {
      if (!allow(req)) return send(res, 429, 'Too many requests', 'text/plain', { 'retry-after': '60' });
      const srt = await cachedSrt(`srt:${m[2]}`, 6 * HOUR, () => downloadSub(m[1], m[2]));
      return send(res, 200, srt, 'application/x-subrip; charset=utf-8', {
        'cache-control': 'public, max-age=86400',
      });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`[${req.url}]`, err.message);
    // Stremio treats errors badly; answer with an empty list for the subtitles route.
    if (pathname.startsWith('/subtitles/')) return send(res, 200, { subtitles: [] });
    send(res, 502, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ktuvit addon running: http://127.0.0.1:${PORT}${PREFIX}/manifest.json`);
    if (!loginCookie && !process.env.KTUVIT_EMAIL) console.warn('WARNING: no ktuvit credentials configured');
  });
}

module.exports = { hashPassword, parseSubsHtml, toUtf8, similarity, server };