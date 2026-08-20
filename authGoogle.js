'use strict';

// 구글(회사 SSO) 로그인 + 세션 쿠키. 외부 패키지 없이 Node 내장 crypto와 전역 fetch만 사용.
// - catchtable.co.kr 도메인 계정만 허용 (ALLOWED_EMAIL_DOMAIN)
// - 세션은 HMAC 서명한 쿠키(sdp_session)로 유지 (서버 상태 없이 자체 검증)
//
// 필요한 환경변수:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (Google Cloud OAuth 2.0 클라이언트)
//   BASE_URL        (기본 http://localhost:3000, 콜백 URL 구성용)
//   SESSION_SECRET  (없으면 LINK_SECRET 사용)
//   ALLOWED_EMAIL_DOMAIN (기본 catchtable.co.kr)

const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || process.env.LINK_SECRET || 'dev-only-insecure-secret';
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'catchtable.co.kr').toLowerCase();
const SESSION_COOKIE = 'sdp_session';
const STATE_COOKIE = 'sdp_oauth_state';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
function redirectUri() {
  return `${baseUrl()}/auth/google/callback`;
}
function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/* ---------- 서명/검증 (쿠키 값) ---------- */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}
function signValue(payload) {
  const body = b64url(payload);
  return `${body}.${hmac(body)}`;
}
function verifyValue(value) {
  if (!value || !value.includes('.')) return null;
  const [body, sig] = value.split('.');
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/* ---------- 쿠키 헬퍼 ---------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (baseUrl().startsWith('https://')) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
  arr.push(parts.join('; '));
  res.setHeader('Set-Cookie', arr);
}

/* ---------- 세션 ---------- */
function setSession(res, user) {
  const payload = { email: user.email, name: user.name || user.email, exp: Date.now() + SESSION_TTL_MS };
  setCookie(res, SESSION_COOKIE, signValue(payload), SESSION_TTL_MS);
}
function clearSession(res) {
  setCookie(res, SESSION_COOKIE, '', 0);
}
function getSession(req) {
  const c = parseCookies(req)[SESSION_COOKIE];
  const p = verifyValue(c);
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return { email: p.email, name: p.name };
}

/* ---------- OAuth 흐름 ---------- */
function getAuthUrl(res) {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, signValue({ state, exp: Date.now() + 10 * 60 * 1000 }), 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state, // CSRF 방지용 state — 콜백에서 쿠키값과 대조 (이게 빠져서 로그인이 계속 튕겼음)
    hd: ALLOWED_DOMAIN, // 회사 도메인 힌트
    access_type: 'online',
    prompt: 'select_account'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function checkState(req, state) {
  const c = parseCookies(req)[STATE_COOKIE];
  const p = verifyValue(c);
  return p && p.state && p.exp > Date.now() && p.state === state;
}

async function exchangeCodeForUser(code) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) {
    throw new Error(`토큰 교환 실패: ${token.error_description || token.error || tokenRes.status}`);
  }
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  const info = await infoRes.json();
  if (!infoRes.ok || !info.email) throw new Error('사용자 정보 조회 실패');

  const email = String(info.email).toLowerCase();
  const domain = (info.hd || email.split('@')[1] || '').toLowerCase();
  if (info.email_verified === false) throw new Error('이메일이 인증되지 않은 계정입니다.');
  if (domain !== ALLOWED_DOMAIN) {
    throw new Error(`허용되지 않은 도메인입니다 (${domain}). ${ALLOWED_DOMAIN} 계정으로 로그인해주세요.`);
  }
  return { email, name: info.name || email };
}

module.exports = {
  isConfigured,
  ALLOWED_DOMAIN,
  getAuthUrl,
  checkState,
  exchangeCodeForUser,
  setSession,
  clearSession,
  getSession,
  parseCookies
};
