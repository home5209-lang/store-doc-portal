'use strict';

// NHN Cloud SMS 발송 API로 문자를 보낸다. (상태 조회에 쓰는 것과 같은 AppKey/SecretKey 사용)
//   POST https://sms.api.nhncloudservice.com/sms/v3.0/appKeys/{appKey}/sender/sms
//   헤더: X-Secret-Key
//   body: { body, sendNo, recipientList: [{ recipientNo }] }
//
// 보내는 번호(sendNo)는 반드시 NHN에 "이미 승인된" 발신번호여야 한다.
// .env 설정:
//   NHN_SMS_APPKEY / NHN_SMS_SECRETKEY  (조회용과 동일)
//   SMS_SENDER_NO = 발신번호(승인된 회사 번호, 숫자만)

const BASE = 'https://sms.api.nhncloudservice.com/sms/v3.0/appKeys';

function clean(v) {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '');
}
function digitsOnly(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

function isConfigured() {
  return Boolean(clean(process.env.NHN_SMS_APPKEY) && clean(process.env.NHN_SMS_SECRETKEY) && digitsOnly(process.env.SMS_SENDER_NO));
}

// 문자 1건 발송. 반환: { ok, statusCode?, message? }
async function sendSms(recipientNo, text) {
  const appKey = clean(process.env.NHN_SMS_APPKEY);
  const secret = clean(process.env.NHN_SMS_SECRETKEY);
  const sendNo = digitsOnly(process.env.SMS_SENDER_NO);
  const to = digitsOnly(recipientNo);
  if (!appKey || !secret || !sendNo) throw new Error('.env 에 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY / SMS_SENDER_NO 를 설정하세요.');
  if (!to) throw new Error('받는 번호가 올바르지 않습니다.');

  const url = `${BASE}/${appKey}/sender/sms`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Secret-Key': secret },
    body: JSON.stringify({ body: String(text || ''), sendNo, recipientList: [{ recipientNo: to }] })
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.header || !json.header.isSuccessful) {
    const msg = (json && json.header && json.header.resultMessage) || `HTTP ${res.status}`;
    throw new Error(`NHN SMS 발송 오류: ${msg}`);
  }
  return { ok: true };
}

module.exports = { isConfigured, sendSms, digitsOnly };
