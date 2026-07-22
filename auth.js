const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

// 관리자 화면 전용 HTTP Basic Auth. ADMIN_USER / ADMIN_PASS 환경변수로 자격증명을 검증한다.
function requireAdminAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!user || !pass) {
    return res
      .status(503)
      .send('관리자 인증 정보가 설정되지 않았습니다. ADMIN_USER, ADMIN_PASS 환경변수를 설정한 뒤 서버를 다시 시작하세요.');
  }

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (timingSafeEqualStr(reqUser, user) && timingSafeEqualStr(reqPass, pass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="store-doc-portal admin"');
  return res.status(401).send('인증이 필요합니다.');
}

module.exports = { requireAdminAuth };
