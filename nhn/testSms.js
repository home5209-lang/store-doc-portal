'use strict';

// 문자 발송 테스트용 스크립트.
//   사용법:  node nhn/testSms.js 01012345678
//   .env 의 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY / SMS_SENDER_NO 를 그대로 사용해
//   지정한 번호로 테스트 문자를 1통 보낸다. (실제 발송 — 요금 발생)

require('dotenv').config();
const { isConfigured, sendSms, digitsOnly } = require('./sendSms');

(async () => {
  const to = digitsOnly(process.argv[2]);
  if (!to) {
    console.error('받는 번호를 입력하세요.  예)  node nhn/testSms.js 01012345678');
    process.exit(1);
  }
  if (!isConfigured()) {
    console.error('.env 의 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY / SMS_SENDER_NO 를 확인하세요.');
    process.exit(1);
  }
  const title = '[캐치테이블] 발신번호 등록 완료 안내';
  const text = '\n담당자님.\n신청하신 발신번호 등록이 완료되었습니다.\n이제 해당 번호로 메시지 발송이 가능합니다.\n\n감사합니다.';
  try {
    const r = await sendSms(to, text, title);
    console.log('✅ 발송 요청 성공 →', to);
    console.log('   방식:', r.endpoint === 'mms' ? 'LMS/MMS(장문)' : 'SMS(단문)', '| 제목 바이트:', r.titleBytes, '(LMS 제목 한도 40)', '| 본문 바이트:', r.bodyBytes);
    if (r.titleBytes > 40) console.log('   ⚠ 제목이 40바이트를 넘어 휴대폰에서 잘릴 수 있습니다.');
    console.log('   휴대폰에서 수신 여부를 확인하세요. (수신까지 몇 초 걸릴 수 있음)');
  } catch (e) {
    console.error('❌ 발송 실패:', e.message);
    process.exit(1);
  }
})();
