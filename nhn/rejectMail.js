'use strict';

// NHN Cloud SMS "발신 전화번호 승인 반려" 메일을 파싱해서
//   (1) 반려 메일인지 판별
//   (2) 발신 신청 번호(마스킹됨, 예: 16**78**)
//   (3) 반려 사유 텍스트
// 를 뽑고, 우리 DB의 매장과 매칭한다.
//
// 왜 필요한가: NHN 사전등록 반려는 API로 조회가 안 되고 "메일로만" 사유가 온다.
//   공용 계정의 메일함을 읽어 이 파서로 사유를 뽑으면, 대시보드에 "거부 + 사유"를 표시할 수 있다.
//
// 매칭 주의: 메일의 번호는 마스킹(16**78**)돼 있어 정확한 번호를 알 수 없다. 그래서
//   (a) 마스킹 패턴(16..78..)을 우리 번호와 대조하고,
//   (b) 사유 문구 안에 들어있는 매장명으로 보강 매칭한다.

function digitsOnly(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}
function normSpace(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}
// 공백 제거(매장명 매칭용: "노량진 101" == "노량진101")
function squash(v) {
  return String(v || '').replace(/\s+/g, '');
}

// 반려 메일인지 판별. 단순히 "반려" 단어가 있다고 잡지 않고,
//   ① 정식 반려 알림 제목("발신 전화번호 승인 반려")이거나
//   ② 본문에 반려 알림 고유 구조("발신 신청 번호 :" + "사유 :")가 있어야 한다.
//   → 설문/문의답변/접수확인 등 '반려' 단어만 들어간 메일은 제외.
function isRejectMail({ from = '', subject = '', text = '' } = {}) {
  const fromOk = /nhncloud\.com/i.test(from);
  const subjectReject = /발신\s*(전화)?\s*번호\s*승인\s*반려/.test(subject);
  const bodyReject = /발신\s*신청\s*번호\s*[:：]/.test(text) && /사유\s*[:：]/.test(text);
  return fromOk && (subjectReject || bodyReject);
}

// "발신 신청 번호 : 16**78**" 에서 마스킹된 번호 문자열을 뽑는다. (숫자와 * 만)
function extractMaskedNumber(text) {
  const m = String(text || '').match(/발신\s*신청\s*번호\s*[:：]\s*([0-9*\s-]+)/);
  if (!m) return null;
  const masked = m[1].replace(/[\s-]/g, ''); // 공백/하이픈 제거 → "16**78**"
  return /[0-9]/.test(masked) ? masked : null;
}

// "사유 : ..." 뒤의 사유 텍스트를 뽑는다. (다음 안내문/서명 전까지)
function extractReason(text) {
  // 사유 뒤의 텍스트를, 끝맺음 인사말/안내(줄바꿈 여부 무관) 전까지 잘라낸다.
  const m = String(text || '').match(
    /사유\s*[:：]\s*([\s\S]*?)\s*(?:NHN\s*Cloud를\s*이용|본\s*이메일|고객센터|감사합니다\.?\s*$|$)/
  );
  return m ? normSpace(m[1]) : null;
}

// 마스킹 번호(16**78**) → 정규식(^16\d\d78\d\d$)으로 변환해 후보 번호와 대조
function maskedMatches(masked, digits) {
  const d = digitsOnly(digits);
  if (!d || !masked) return false;
  if (d.length !== masked.length) return false;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '*') continue; // 아무 숫자나 허용
    if (c !== d[i]) return false;
  }
  return true;
}

// 메일 한 통을 파싱해 { isReject, maskedNumber, reason } 반환 (반려 아니면 isReject:false)
function parseRejectEmail(mail = {}) {
  if (!isRejectMail(mail)) return { isReject: false };
  const text = mail.text || '';
  return {
    isReject: true,
    maskedNumber: extractMaskedNumber(text),
    reason: extractReason(text)
  };
}

// 파싱 결과를 매장 목록과 매칭. stores: [{ id, name, phone_numbers }]
//   1순위: 마스킹 번호 패턴이 일치하는 매장
//   2순위(보강/확정): 사유 문구 안에 매장명이 포함
// 반환: { store, by } | null   (by: 'number' | 'name' | 'number+name')
function matchStore(parsed, stores = []) {
  if (!parsed || !parsed.isReject) return null;
  const reasonSquashed = squash(parsed.reason || '');

  const byNumber = [];
  for (const s of stores) {
    const nums = String(s.phone_numbers || '').split(/[,/\n;]/);
    if (parsed.maskedNumber && nums.some((n) => maskedMatches(parsed.maskedNumber, n))) {
      byNumber.push(s);
    }
  }
  const nameHit = (s) => s.name && reasonSquashed.includes(squash(s.name));

  // 번호로 좁힌 뒤 이름으로 확정
  if (byNumber.length === 1) {
    return { store: byNumber[0], by: nameHit(byNumber[0]) ? 'number+name' : 'number' };
  }
  if (byNumber.length > 1) {
    const narrowed = byNumber.filter(nameHit);
    if (narrowed.length === 1) return { store: narrowed[0], by: 'number+name' };
  }
  // 번호로 못 좁히면 이름만으로 시도
  const byName = stores.filter(nameHit);
  if (byName.length === 1) return { store: byName[0], by: 'name' };

  return null; // 애매하면 자동 반영하지 않음(오매칭 방지)
}

module.exports = {
  isRejectMail,
  extractMaskedNumber,
  extractReason,
  maskedMatches,
  parseRejectEmail,
  matchStore
};
