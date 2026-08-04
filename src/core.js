export const TRIMBLE_ID_BASE = 'https://id.trimble.com';
export const CONNECT_REGIONS = {
  us: 'https://app.connect.trimble.com',
  eu: 'https://app21.connect.trimble.com',
  asia: 'https://app31.connect.trimble.com'
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

export function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function sessionCookie(value, maxAge = 3600) {
  return `m3d_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function oauthStateCookie(value) {
  return `m3d_oauth_state=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function buildTrimbleAuthorizeUrl(env, state, prompt = 'login') {
  const url = new URL('/oauth/authorize', TRIMBLE_ID_BASE);
  url.searchParams.set('client_id', env.TRIMBLE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `openid ${env.TRIMBLE_APP_NAME}`);
  url.searchParams.set('redirect_uri', env.TRIMBLE_CALLBACK_URL);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', prompt);
  url.searchParams.set('ui_locales', 'es-AR');
  return url.toString();
}

export function trimbleApiBase(region = 'us') {
  return CONNECT_REGIONS[region] || CONNECT_REGIONS.us;
}
