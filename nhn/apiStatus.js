'use strict';

// NHN Cloud SMS "등록된 발신 번호 목록 검색 API"로 발신번호 상태를 조회한다.
//   GET https://sms.api.nhncloudservice.com/sms/v3.0/appKeys/{appKey}/sendNos
//   헤더: X-Secret-Key
// 로그인/브라우저 없이 API 키(AppKey + SecretKey)만으로 동작한다.
//
// 상태 해석:
//   - 조회됨 + blockYn != 'Y'  → registered (승인/등록완료)
//   - 조회됨 + blockYn == 'Y'  → rejected   (거부/차단, blockReason 있으면 사유)
//   - 조회 안 됨               → 목록에 없음(심사중이거나 미승인) → 상태 변경 안 함
//
// ⚠️ 계정 발신번호가 많으면 전체 목록(pageSize)로는 누락될 수 있어, 상태 판정은
//    번호를 콕 집어(sendNo 파라미터) 조회하는 fetchByNumber 를 사용한다.

const BASE = 'https://sms.api.nhncloudservice.com/sms/v3.0/appKeys';

function clean(v) {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '');
}
function digitsOnly(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}
function isConfigured() {
  return Boolean(clean(process.env.NHN_SMS_APPKEY) && clean(process.env.NHN_SMS_SECRETKEY));
}

async function callSendNos(queryString) {
  const appKey = clean(process.env.NHN_SMS_APPKEY);
  const secret = clean(process.env.NHN_SMS_SECRETKEY);
  if (!appKey || !secret) throw new Error('.env 에 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY 를 설정하세요.');
  const url = `${BASE}/${appKey}/sendNos?${queryString}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Secret-Key': secret }
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.header || !json.header.isSuccessful) {
    const msg = (json && json.header && json.header.resultMessage) || `HTTP ${res.status}`;
    throw new Error(`NHN API 응답 오류: ${msg}`);
  }
  const body = json.body || {};
  return { rows: body.data || [], totalCount: body.totalCount };
}

// 특정 발신번호 1건의 상태를 조회한다. 반환: { phone, blockYn, useYn, blockReason } | null
async function fetchByNumber(phone) {
  const d = digitsOnly(phone);
  if (!d) return null;
  const { rows } = await callSendNos(`sendNo=${encodeURIComponent(d)}&pageNum=1&pageSize=100`);
  const hit = rows.find((r) => digitsOnly(r.sendNo) === d);
  if (!hit) return null;
  return { phone: d, blockYn: hit.blockYn, useYn: hit.useYn, blockReason: hit.blockReason || null };
}

// 전체 목록(진단/디버그용). 많으면 잘릴 수 있으므로 상태 판정에는 fetchByNumber 를 쓸 것.
async function fetchSenderStatuses() {
  const { rows, totalCount } = await callSendNos('pageNum=1&pageSize=1000');
  return {
    totalCount,
    list: rows.map((r) => ({
      phone: digitsOnly(r.sendNo),
      blockYn: r.blockYn,
      useYn: r.useYn,
      blockReason: r.blockReason || null
    }))
  };
}

module.exports = { isConfigured, fetchByNumber, fetchSenderStatuses, digitsOnly };
