/**
 * Roots & Memories – Cloudflare Worker backend
 *
 * - Sign-in: Telegram Login (OpenID Connect, Authorization Code + PKCE)
 * - Access:  only Telegram user IDs in ADMIN_USER_ID / ALLOWED_USER_IDS
 * - Storage: a private Telegram channel owned by the admin account.
 *            A bot (admin of the channel) posts:
 *              • every photo as a document (original quality)
 *              • the family data as a JSON document, which is then pinned.
 *            The pinned JSON is the "current version"; older JSON posts
 *            remain in the channel as version history.
 *
 * The bot token and client secret never leave this Worker.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const TG_ISS = 'https://oauth.telegram.org';
const SESSION_DAYS = 35;
const MAX_UPLOAD = 20 * 1024 * 1024; // Bot API getFile can only download files up to 20 MB
const MAX_DATA = 10 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      // Digital Asset Links for the Android app (Trusted Web Activity) – paste the JSON from PWABuilder into ANDROID_ASSETLINKS.
      if (p === '/.well-known/assetlinks.json') {
        if (!env.ANDROID_ASSETLINKS) return json([], 200);
        return new Response(env.ANDROID_ASSETLINKS, { headers: { 'content-type': 'application/json' } });
      }
      if (p === '/auth/login' && req.method === 'GET') return login(url, env);
      if (p === '/auth/callback' && req.method === 'GET') return callback(req, url, env);
      if (p === '/auth/logout' && req.method === 'POST') {
        if (!sameOrigin(req, url)) return json({ error: 'bad_origin' }, 403);
        return new Response(null, { status: 204, headers: { 'Set-Cookie': clearCookie('session', '/') } });
      }

      if (p.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req, url)) return json({ error: 'bad_origin' }, 403);
        const user = await currentUser(req, env);
        if (!user) return json({ error: 'unauthorized' }, 401);

        if (p === '/api/me' && req.method === 'GET') return json({ user });
        if (p === '/api/data' && req.method === 'GET') return loadData(env);
        if (p === '/api/data' && req.method === 'PUT') return saveData(req, env, user);
        if (p === '/api/upload' && req.method === 'POST') return upload(req, env, user);
        if (p.startsWith('/api/file/') && req.method === 'GET') return fileProxy(p, env);
        return json({ error: 'not_found' }, 404);
      }

      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error', detail: String((e && e.message) || e) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Auth: Telegram OpenID Connect                                       */
/* ------------------------------------------------------------------ */

async function login(url, env) {
  const state = b64u(rand(16));
  const verifier = b64u(rand(32));
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const auth = new URL(TG_ISS + '/auth');
  auth.search = new URLSearchParams({
    client_id: String(env.TG_CLIENT_ID),
    redirect_uri: url.origin + '/auth/callback',
    response_type: 'code',
    scope: 'openid profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const flow = await sign({ state, verifier, exp: now() + 600 }, env);
  return redirect(auth.toString(), [setCookie('tg_oauth', flow, 600, '/auth')]);
}

async function callback(req, url, env) {
  const q = url.searchParams;
  const clear = clearCookie('tg_oauth', '/auth');
  const fail = (why) => redirect('/#login_error=' + encodeURIComponent(why), [clear]);

  if (q.get('error')) return fail(q.get('error'));
  const flow = await verify(getCookie(req, 'tg_oauth'), env);
  if (!flow || !q.get('code') || flow.state !== q.get('state')) return fail('state_mismatch');

  const r = await fetch(TG_ISS + '/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + btoa(`${env.TG_CLIENT_ID}:${env.TG_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: url.origin + '/auth/callback',
      client_id: String(env.TG_CLIENT_ID),
      code_verifier: flow.verifier,
    }).toString(),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) return fail('token_exchange');

  const claims = await verifyIdToken(tok.id_token, env);
  if (!claims) return fail('invalid_id_token');

  // `id` = Telegram user ID (profile scope). `sub` is an opaque OIDC subject.
  const tgId = String(claims.id ?? claims.sub);
  if (!allowedIds(env).has(tgId)) {
    return redirect('/#denied=' + encodeURIComponent(tgId), [clear]);
  }

  const user = {
    id: tgId,
    name: claims.name || claims.preferred_username || 'Family member',
    username: claims.preferred_username || null,
    picture: claims.picture || null,
    admin: tgId === String(env.ADMIN_USER_ID),
    exp: now() + SESSION_DAYS * 86400,
  };
  return redirect('/', [setCookie('session', await sign(user, env), SESSION_DAYS * 86400, '/'), clear]);
}

let jwksCache = null;
let jwksAt = 0;
async function getJwks(force) {
  if (!force && jwksCache && Date.now() - jwksAt < 3600e3) return jwksCache;
  const r = await fetch(TG_ISS + '/.well-known/jwks.json');
  if (!r.ok) throw new Error('Could not fetch Telegram JWKS');
  jwksCache = (await r.json()).keys || [];
  jwksAt = Date.now();
  return jwksCache;
}

const ALGS = {
  RS256: { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } },
};

async function verifyIdToken(token, env) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(dec.decode(unb64u(h)));
    claims = JSON.parse(dec.decode(unb64u(p)));
  } catch {
    return null;
  }
  const alg = ALGS[header.alg];
  if (!alg) return null; // keep RS256 (Telegram default) or ES256 in BotFather

  let jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk || (jwk.alg && jwk.alg !== header.alg)) return null;

  const { kty, n, e, crv, x, y } = jwk;
  const key = await crypto.subtle.importKey('jwk', clean({ kty, n, e, crv, x, y, ext: true }), alg.imp, false, ['verify']);
  const ok = await crypto.subtle.verify(alg.ver, key, unb64u(s), enc.encode(h + '.' + p));
  if (!ok) return null;

  if (claims.iss !== TG_ISS) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  if (!aud.includes(String(env.TG_CLIENT_ID))) return null;
  if (!claims.exp || claims.exp < now() - 60) return null;
  return claims;
}

async function currentUser(req, env) {
  const user = await verify(getCookie(req, 'session'), env);
  if (!user) return null;
  // Re-check on every request so removing someone from the list revokes access immediately.
  return allowedIds(env).has(String(user.id)) ? user : null;
}

function allowedIds(env) {
  return new Set(
    [...String(env.ALLOWED_USER_IDS || '').split(/[\s,]+/), String(env.ADMIN_USER_ID || '')].filter(Boolean)
  );
}

/* ------------------------------------------------------------------ */
/* Storage: Telegram Bot API + private channel                         */
/* ------------------------------------------------------------------ */

async function tg(env, method, body) {
  const init =
    body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, init);
  const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function downloadTgFile(env, fileId) {
  const f = await tg(env, 'getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error('Telegram file download failed: ' + r.status);
  return { res: r, path: f.file_path };
}

async function currentPin(env) {
  const chat = await tg(env, 'getChat', { chat_id: env.CHANNEL_ID });
  const pin = chat.pinned_message;
  return pin && pin.document ? pin : null;
}

async function loadData(env) {
  const pin = await currentPin(env);
  if (!pin) return json({ data: null, version: null });
  const { res } = await downloadTgFile(env, pin.document.file_id);
  return json({ data: await res.json(), version: pin.message_id });
}

async function saveData(req, env, user) {
  const raw = await req.text();
  if (raw.length > MAX_DATA) return json({ error: 'too_large' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const data = body && body.data;
  if (!data || !Array.isArray(data.people) || !Array.isArray(data.memories)) return json({ error: 'bad_data' }, 400);

  // Optimistic concurrency: client must send the version it last loaded.
  const pin = await currentPin(env);
  const cur = pin ? pin.message_id : null;
  if ((body.version ?? null) !== cur) return json({ error: 'conflict', version: cur }, 409);

  const fd = new FormData();
  fd.append('chat_id', String(env.CHANNEL_ID));
  fd.append(
    'document',
    new Blob([JSON.stringify(data)], { type: 'application/json' }),
    `family-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fd.append('caption', `Data saved by ${user.name} (${user.id})`);
  fd.append('disable_notification', 'true');
  const msg = await tg(env, 'sendDocument', fd);
  await tg(env, 'pinChatMessage', { chat_id: env.CHANNEL_ID, message_id: msg.message_id, disable_notification: true });
  return json({ version: msg.message_id });
}

async function upload(req, env, user) {
  const form = await req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'no_file' }, 400);
  if (file.size > MAX_UPLOAD) return json({ error: 'too_large', limitMB: 20 }, 413);
  if (!/^image\//.test(file.type || '')) return json({ error: 'images_only' }, 415);

  const fd = new FormData();
  fd.append('chat_id', String(env.CHANNEL_ID));
  fd.append('document', file, file.name || 'photo.jpg');
  fd.append('caption', `Photo uploaded by ${user.name}`);
  fd.append('disable_notification', 'true');
  const msg = await tg(env, 'sendDocument', fd);
  const doc = msg.document || (msg.photo && msg.photo[msg.photo.length - 1]);
  if (!doc) throw new Error('Telegram did not return a file');
  return json({ fileId: doc.file_id });
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' };

async function fileProxy(path, env) {
  const fileId = decodeURIComponent(path.slice('/api/file/'.length));
  if (!fileId) return json({ error: 'bad_file' }, 400);
  const { res, path: fp } = await downloadTgFile(env, fileId);
  const ext = (fp.split('.').pop() || '').toLowerCase();
  return new Response(res.body, {
    headers: {
      'content-type': MIME[ext] || res.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'private, max-age=604800, immutable',
    },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => Math.floor(Date.now() / 1000);
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET missing or too short');
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(obj, env) {
  const p = b64u(enc.encode(JSON.stringify(obj)));
  const s = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(p)));
  return p + '.' + s;
}
async function verify(token, env) {
  if (!token) return null;
  const [p, s] = String(token).split('.');
  if (!p || !s) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(s), enc.encode(p)))) return null;
    const o = JSON.parse(dec.decode(unb64u(p)));
    return o.exp && o.exp > now() ? o : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const setCookie = (name, val, maxAge, path) =>
  `${name}=${encodeURIComponent(val)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const clearCookie = (name, path) => `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function sameOrigin(req, url) {
  return req.headers.get('Origin') === url.origin;
}
function redirect(location, cookies = []) {
  const h = new Headers({ Location: location, 'cache-control': 'no-store' });
  cookies.forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
