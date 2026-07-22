const crypto = require('crypto');

const SECRET = process.env.LINK_SECRET || 'dev-only-insecure-secret-change-me';
if (!process.env.LINK_SECRET) {
  console.warn(
    '[tokens] LINK_SECRET 환경변수가 없어 개발용 기본 시크릿을 사용합니다. 운영 배포 전에는 반드시 환경변수로 설정하세요.'
  );
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

function sign(storeId, exp) {
  return crypto.createHmac('sha256', SECRET).update(`${storeId}.${exp}`).digest('base64url');
}

// storeId + 만료시각을 서명해서 하나의 토큰으로 묶는다 (DB 조회 없이 자체 검증 가능)
function generateUploadToken(storeId, ttlMs = DEFAULT_TTL_MS) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(storeId, exp)}`;
}

function verifyUploadToken(storeId, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed' };
  }

  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !sig) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = sign(storeId, exp);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  const sigValid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  if (!sigValid) {
    return { valid: false, reason: 'invalid' };
  }
  if (Date.now() > exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}

module.exports = { generateUploadToken, verifyUploadToken, DEFAULT_TTL_MS };
