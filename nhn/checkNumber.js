'use strict';

// 진단용: 특정 발신번호가 NHN sendNos API에 "어떻게" 나오는지 원본 그대로 찍어본다.
//   목적 — 거부(반려)된 번호가 API 목록에 blockYn=Y 로 나오는지, 아니면 아예 빠지는지 확인.
//
// 사용법 (프로젝트 루트에서):
//   node nhn/checkNumber.js 16446148 16447811
//   (번호 여러 개 공백으로 나열. 하이픈 있어도 됨)
//
// .env 의 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY 를 사용한다.

require('dotenv').config();

const BASE = 'https://sms.api.nhncloudservice.com/sms/v3.0/appKeys';

function clean(v) {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '');
}
function digitsOnly(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

async function rawSendNos(queryString) {
  const appKey = clean(process.env.NHN_SMS_APPKEY);
  const secret = clean(process.env.NHN_SMS_SECRETKEY);
  if (!appKey || !secret) {
    throw new Error('.env 에 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY 를 설정하세요.');
  }
  const url = `${BASE}/${appKey}/sendNos?${queryString}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Secret-Key': secret }
  });
  const json = await res.json().catch(() => null);
  return { httpStatus: res.status, json };
}

(async () => {
  const nums = process.argv.slice(2).map(digitsOnly).filter(Boolean);
  if (!nums.length) {
    console.log('사용법: node nhn/checkNumber.js 16446148 16447811');
    process.exit(1);
  }

  for (const d of nums) {
    console.log('\n==============================');
    console.log(`▶ 번호 ${d} 조회`);
    console.log('==============================');

    // 1) 번호 지정 조회 (현재 앱이 쓰는 방식)
    try {
      const { httpStatus, json } = await rawSendNos(
        `sendNo=${encodeURIComponent(d)}&pageNum=1&pageSize=100`
      );
      const ok = json && json.header && json.header.isSuccessful;
      console.log(`[sendNo 필터] HTTP ${httpStatus}, isSuccessful=${ok}`);
      if (!ok) {
        console.log('  header:', JSON.stringify(json && json.header));
      }
      const rows = (json && json.body && json.body.data) || [];
      console.log(`  totalCount=${json && json.body && json.body.totalCount}, 반환행=${rows.length}`);
      if (rows.length) {
        rows.forEach((r) => {
          console.log(
            `  · sendNo=${r.sendNo} useYn=${r.useYn} blockYn=${r.blockYn} blockReason=${JSON.stringify(
              r.blockReason
            )}`
          );
        });
        // 원본 전체(필드 확인용)
        console.log('  [원본 첫 행]', JSON.stringify(rows[0]));
      } else {
        console.log('  → 이 번호는 sendNos 목록에 없음 (승인 목록 미포함).');
      }
    } catch (e) {
      console.log('  조회 오류:', e.message);
    }
  }

  // 2) 참고: 전체 목록의 blockYn=Y(차단) 건이 있는지 훑어보기 (최대 2000건)
  console.log('\n------------------------------');
  console.log('▶ 참고: 계정 전체에서 blockYn=Y(차단/거부) 건 스캔');
  console.log('------------------------------');
  try {
    let blocked = [];
    for (const pageNum of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const { json } = await rawSendNos(`pageNum=${pageNum}&pageSize=1000`);
      const rows = (json && json.body && json.body.data) || [];
      blocked = blocked.concat(rows.filter((r) => r.blockYn === 'Y'));
      if (rows.length < 1000) break;
    }
    console.log(`  전체에서 blockYn=Y 건수: ${blocked.length}`);
    blocked.slice(0, 20).forEach((r) => {
      console.log(`  · ${r.sendNo} blockReason=${JSON.stringify(r.blockReason)}`);
    });
  } catch (e) {
    console.log('  전체 스캔 오류:', e.message);
  }
})();
