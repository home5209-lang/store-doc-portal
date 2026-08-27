'use strict';

// 모두싸인 "서명자(참가자) 검색" 필터 문법을 찾기 위한 진단 스크립트.
//   사용법:  node probe-modusign.js 노량진101
//   .env 의 MODUSIGN_EMAIL / MODUSIGN_API_KEY(또는 API_KEY) 를 사용해
//   여러 검색 방식을 실제 모두싸인 API에 찔러보고, 어느 것이 결과를 주는지 출력한다.

require('dotenv').config();

const BASE = 'https://api.modusign.co.kr';

function authHeader() {
  const email = process.env.MODUSIGN_EMAIL;
  const apiKey = process.env.MODUSIGN_API_KEY || process.env.API_KEY;
  if (!email || !apiKey) throw new Error('.env 에 MODUSIGN_EMAIL / MODUSIGN_API_KEY 를 설정하세요.');
  return 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64');
}

function countOf(json) {
  if (!json) return 0;
  const arr = Array.isArray(json) ? json : (json.documents || json.data || json.items || json.results || []);
  return Array.isArray(arr) ? arr.length : 0;
}
function firstTitles(json, n = 3) {
  const arr = Array.isArray(json) ? json : (json && (json.documents || json.data || json.items || json.results)) || [];
  return arr.slice(0, n).map((d) => d.title || d.name || '(제목없음)');
}

async function tryUrl(label, pathAndQuery) {
  const url = `${BASE}${pathAndQuery}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: authHeader() } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    if (!res.ok) {
      console.log(`  [HTTP ${res.status}] ${label}\n     ${text.slice(0, 160)}`);
      return;
    }
    const c = countOf(json);
    console.log(`  [OK ${c}건] ${label}` + (c ? `  →  ${firstTitles(json).join(' | ')}` : ''));
  } catch (e) {
    console.log(`  [예외] ${label} : ${e.message}`);
  }
}

(async () => {
  const q = (process.argv[2] || '').trim();
  if (!q) { console.error('검색어를 입력하세요. 예)  node probe-modusign.js 노량진101'); process.exit(1); }
  const enc = encodeURIComponent(q);
  console.log(`\n== 모두싸인 검색 방식 진단 (검색어: "${q}") ==\n`);

  const filters = [
    `status eq 'COMPLETED' and contains(title, '${q}')`,
    `status eq 'COMPLETED' and contains(participantName, '${q}')`,
    `status eq 'COMPLETED' and contains(participantNames, '${q}')`,
    `status eq 'COMPLETED' and contains(signerName, '${q}')`,
    `status eq 'COMPLETED' and contains(participants/name, '${q}')`,
    `status eq 'COMPLETED' and participants/any(p: contains(p/name, '${q}'))`,
    `status eq 'COMPLETED' and participants/any(p: contains(p/signerName, '${q}'))`,
    `contains(participantName, '${q}')`
  ];
  console.log('[A] filter= 방식');
  for (const f of filters) {
    // eslint-disable-next-line no-await-in-loop
    await tryUrl(`filter=${f}`, `/documents?offset=0&limit=5&filter=${encodeURIComponent(f)}`);
  }

  console.log('\n[B] 별도 파라미터 방식');
  const paramTries = [
    `/documents?offset=0&limit=5&participantName=${enc}`,
    `/documents?offset=0&limit=5&signerName=${enc}`,
    `/documents?offset=0&limit=5&q=${enc}`,
    `/documents?offset=0&limit=5&keyword=${enc}`,
    `/documents?offset=0&limit=5&search=${enc}`,
    `/documents?offset=0&limit=5&participant=${enc}`
  ];
  for (const p of paramTries) {
    // eslint-disable-next-line no-await-in-loop
    await tryUrl(p.split('?')[1], p);
  }

  // [C] 목록 응답에 "서명자(참가자)" 정보가 들어있는지 확인
  console.log('\n[C] 목록 응답 구조 확인 (서명자 정보 포함 여부)');
  try {
    const res = await fetch(`${BASE}/documents?offset=0&limit=2&filter=${encodeURIComponent("status eq 'COMPLETED'")}`,
      { headers: { Accept: 'application/json', Authorization: authHeader() } });
    const json = await res.json();
    const arr = Array.isArray(json) ? json : (json.documents || json.data || json.items || json.results || []);
    console.log('  최상위 키:', Object.keys(json || {}).join(', ') || '(배열)');
    const d = arr[0] || {};
    console.log('  문서 키:', Object.keys(d).join(', '));
    const parts = d.participants || d.signers || d.parties || null;
    if (parts) {
      console.log('  참가자 배열 존재 O — 첫 참가자 키:', Object.keys(parts[0] || {}).join(', '));
      console.log('  참가자 이름 예시:', (parts || []).map((p) => p.name || p.signerName || '?').join(', '));
    } else {
      console.log('  참가자 배열 없음 X — 목록 응답엔 서명자 정보가 없습니다.');
    }
  } catch (e) {
    console.log('  구조 확인 실패:', e.message);
  }

  console.log('\n끝.');
})();
