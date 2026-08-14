'use strict';

// 진단용: NHN SMS 발신번호 API 상태 확인
//   1) 전체 발신번호 개수(totalCount) — 1000보다 크면 전체목록 조회로는 누락됨
//   2) 특정 번호를 콕 집어 조회 → 승인/거부/없음 판정
//
// 사용법 (프로젝트 폴더에서):
//   node nhn/checkSendNos.js                 (기본: 031-8003-6262 확인)
//   node nhn/checkSendNos.js 021234 5678     (원하는 번호 확인)
//
// (.env 의 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY 사용 — 키는 화면에 출력되지 않음)

require('dotenv').config({ quiet: true });
const { isConfigured, fetchByNumber, fetchSenderStatuses, digitsOnly } = require('./apiStatus');

if (!isConfigured()) {
  console.error('먼저 .env 에 NHN_SMS_APPKEY, NHN_SMS_SECRETKEY 를 넣어주세요.');
  process.exit(1);
}

// 확인할 번호 (인자로 주면 그 번호, 없으면 테스트 번호)
const target = digitsOnly(process.argv.slice(2).join('') || '031-8003-6262');

(async () => {
  const { totalCount, list } = await fetchSenderStatuses();
  console.log(`\n=== 계정 발신번호 총 ${totalCount}건 (전체목록 조회는 최대 1000건만 봄) ===`);
  if (totalCount > 1000) {
    console.log('⚠️ 1000건이 넘어서 전체목록으로는 일부 번호가 누락됩니다 → 번호 지정 조회로 판정합니다.');
  }

  console.log(`\n=== 번호 지정 조회: ${target} ===`);
  const hit = await fetchByNumber(target);
  if (!hit) {
    console.log('→ 목록에 없음 (= 승인 안 됨: 심사중이거나 거부되어 목록에서 빠진 상태)');
  } else if (hit.blockYn === 'Y') {
    console.log(`→ 거부/차단 (blockYn=Y)  사유: ${hit.blockReason || '(없음)'}`);
  } else {
    console.log(`→ 승인/등록완료 (useYn=${hit.useYn}, blockYn=${hit.blockYn})`);
  }
  console.log('\n원본:', JSON.stringify(hit, null, 2));
})().catch((e) => {
  console.error('오류:', e.message);
  process.exit(1);
});
