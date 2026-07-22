'use strict';

/**
 * 모두싸인 연동 로컬 점검 스크립트.
 *
 * 사용법:
 *   node scripts/test-modusign.js "매장명"
 *
 * 하는 일:
 *   1) 환경변수(MODUSIGN_EMAIL / MODUSIGN_API_KEY)가 잡혔는지 확인
 *   2) 서명 완료 문서 목록을 실제로 한 번 불러와 응답 구조(제목/서명자/ID)를 출력
 *   3) 넘긴 매장명으로 findBestContractMatch를 돌려 상위 후보와 판정 결과를 출력
 *
 * ※ 실제 파일 다운로드는 하지 않습니다. (조회/매칭까지만 확인)
 */

// .env 를 직접 읽어 환경변수로 로드한다. (npm 설치 없이도 이 점검 스크립트가 동작하도록 dotenv 미사용)
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const {
  getModusignCredentials,
  listCompletedDocuments,
  findBestContractMatch,
  normalizeStoreName,
} = require('../contractStub');

async function main() {
  const storeName = process.argv[2];

  const { email, apiKey } = getModusignCredentials();
  console.log('=== 1) 자격증명 확인 ===');
  console.log('MODUSIGN_EMAIL :', email ? email : '(없음)');
  console.log('API KEY        :', apiKey ? `설정됨 (${String(apiKey).slice(0, 4)}…)` : '(없음)');
  if (!email || !apiKey) {
    console.error('\n환경변수가 없습니다. .env에 MODUSIGN_EMAIL / MODUSIGN_API_KEY 를 넣어주세요.');
    process.exit(1);
  }

  console.log('\n=== 2) 완료 문서 목록 조회 ===');
  const docs = await listCompletedDocuments({ maxPages: 3, pageSize: 100 });
  console.log(`불러온 완료 문서 수: ${docs.length}`);
  if (docs.length === 0) {
    console.log('완료된 문서가 없습니다. (계약이 아직 서명 완료 상태가 아닐 수 있음)');
    return;
  }
  console.log('첫 문서의 최상위 키:', Object.keys(docs[0]));

  const compact = (s) => normalizeStoreName(s).replace(/\s+/g, '');
  const namesOf = (d) =>
    (d.participants || d.signers || d.parties || [])
      .map((p) => p && (p.name || p.signerName))
      .filter(Boolean);

  if (!storeName) {
    console.log('\n(처음 20건 제목)');
    docs.slice(0, 20).forEach((d, i) => console.log(`  [${i}] "${d.title || d.name || ''}"`));
    console.log('\n매장명을 인자로 넘기면 관련 계약서/매칭을 확인합니다. 예) node scripts/test-modusign.js "푸시풋살룬"');
    return;
  }

  const target = compact(storeName);
  console.log(`\n=== "${storeName}" 관련 완료 문서 (제목/서명자에 이름 포함 — 계약 종류 확인용) ===`);
  const related = docs.filter((d) => {
    const title = d.title || d.name || '';
    const parts = namesOf(d).join(' ');
    return compact(title).includes(target) || compact(parts).includes(target);
  });
  if (related.length === 0) console.log('  (관련 문서 없음)');
  related.forEach((d) => {
    console.log(`  - title="${d.title || d.name || ''}" 서명자=${JSON.stringify(namesOf(d))} id=${d.id || d.documentId}`);
  });

  console.log(`\n=== 3) "${storeName}" 현재 매칭 결과 ===`);
  const result = await findBestContractMatch(storeName);
  console.log('판정:', result.status);
  result.ranked.forEach((r, i) => {
    console.log(
      `  ${i + 1}. score=${r.score.toFixed(3)} [${r.matchedField}] title="${r.title}" (docId=${r.documentId})`
    );
  });
}

main().catch((err) => {
  console.error('\n[오류]', err.message);
  process.exit(1);
});
