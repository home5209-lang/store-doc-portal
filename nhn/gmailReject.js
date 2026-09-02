'use strict';

// Gmail을 "읽기 전용"으로 조회해 NHN 반려 메일을 가져온다. (외부 패키지 없이 REST + fetch)
//   - 로그인용 구글 OAuth 클라이언트(GOOGLE_CLIENT_ID/SECRET)를 그대로 재사용
//   - 최초 1회 계정이 gmail.readonly 권한을 허용 → refresh token 저장(nhn/gmail-token.json)
//   - 이후 서버가 refresh token으로 access token을 받아 반려 메일을 읽는다
//
// 저장 파일(nhn/gmail-token.json)은 자격증명이므로 .gitignore 대상.

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
function redirectUri() {
  return `${baseUrl()}/admin/gmail/callback`;
}
function clientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}
function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || '';
}

/* ---------- 토큰 저장/로드 ---------- */
function saveToken(obj) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}
function isConnected() {
  const t = loadToken();
  return Boolean(t && t.refresh_token);
}
function connectedEmail() {
  const t = loadToken();
  return (t && t.email) || null;
}
function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

/* ---------- OAuth (gmail.readonly 권한 획득) ---------- */
// 연동 시작 URL. state는 호출부(server)가 CSRF용으로 넘긴다.
function getConnectUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPE,
    state,
    access_type: 'offline', // refresh token 받기
    prompt: 'consent', // 매번 동의 → refresh token 확실히 발급
    include_granted_scopes: 'true'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// 콜백 code → refresh token 교환 후 저장. 연동한 계정 이메일도 함께 기록.
async function exchangeAndStore(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  });
  const token = await res.json();
  if (!res.ok || !token.access_token) {
    throw new Error(`토큰 교환 실패: ${token.error_description || token.error || res.status}`);
  }
  if (!token.refresh_token) {
    throw new Error('refresh token이 없습니다. 구글 계정 [보안]에서 이 앱 접근을 해제한 뒤 다시 연동하세요.');
  }
  // 연동 계정 이메일 확인 (gmail.readonly로 프로필 조회)
  let email = null;
  try {
    const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const pj = await p.json();
    email = pj.emailAddress || null;
  } catch (e) {
    /* 무시 */
  }
  saveToken({ refresh_token: token.refresh_token, email, obtained_at: new Date().toISOString() });
  return { email };
}

// refresh token → access token
async function getAccessToken() {
  const t = loadToken();
  if (!t || !t.refresh_token) throw new Error('Gmail이 연동되어 있지 않습니다. /admin/gmail/connect 로 먼저 연동하세요.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const token = await res.json();
  if (!res.ok || !token.access_token) {
    throw new Error(`access token 갱신 실패: ${token.error_description || token.error || res.status}`);
  }
  return token.access_token;
}

/* ---------- 메일 본문 추출 ---------- */
function b64urlDecode(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n');
}
// payload(파트 트리)에서 본문 텍스트를 뽑는다.
//   text/plain 과 text/html 을 모두 뽑아, "실제 반려 내용(라벨)이 있는 쪽"을 고른다.
//   (일부 메일은 text/plain 이 거의 비어있고 HTML 에만 내용이 있어, 무조건 plain 우선이면 빈 값이 됨)
function extractText(payload) {
  if (!payload) return '';
  const walk = (node, want) => {
    if (!node) return '';
    if (node.mimeType === want && node.body && node.body.data) return b64urlDecode(node.body.data);
    if (node.parts) {
      for (const p of node.parts) {
        const r = walk(p, want);
        if (r) return r;
      }
    }
    return '';
  };
  const plain = walk(payload, 'text/plain');
  const htmlRaw = walk(payload, 'text/html');
  const html = htmlRaw ? stripHtml(htmlRaw) : '';
  const hasLabels = (s) => /발신\s*신청\s*번호|사유\s*[:：]|반려/.test(s || '');
  if (hasLabels(plain)) return plain;
  if (hasLabels(html)) return html;
  // 라벨이 둘 다 없으면 더 내용이 긴 쪽을 반환
  return (plain || '').trim().length >= (html || '').trim().length ? plain : html;
}
function headerOf(payload, name) {
  const h = (payload.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/* ---------- 반려 메일 가져오기 ---------- */
// 반환: [{ id, from, subject, text }]
async function fetchRejectMails({ newerThanDays = 60, max = 30 } = {}) {
  const accessToken = await getAccessToken();
  const q = `from:noreply@nhncloud.com 발신 반려 newer_than:${newerThanDays}d`;
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listRes.json();
  if (!listRes.ok) throw new Error(`메일 목록 조회 실패: ${(list.error && list.error.message) || listRes.status}`);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    // eslint-disable-next-line no-await-in-loop
    const msg = await mRes.json();
    if (!mRes.ok) continue;
    const payload = msg.payload || {};
    out.push({
      id,
      from: headerOf(payload, 'From'),
      subject: headerOf(payload, 'Subject'),
      text: extractText(payload),
      dateMs: Number(msg.internalDate) || 0 // 메일 수신 시각(epoch ms)
    });
  }
  return out;
}

module.exports = {
  TOKEN_PATH,
  isConfigured,
  isConnected,
  connectedEmail,
  getConnectUrl,
  exchangeAndStore,
  getAccessToken,
  fetchRejectMails,
  extractText,
  stripHtml
};
