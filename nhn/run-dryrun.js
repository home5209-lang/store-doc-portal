'use strict';

// 로컬모티브 매장 서류 5종으로 NHN 봇을 "드라이런"(제출 직전까지) 실행.
// 실행: node nhn/run-dryrun.js
// 준비물: 1) node nhn/capture-session.js 로 로그인 세션 저장
//         2) 바탕화면에 로컬모티브 서류 5개(jpg/png)
//
// 실제 제출까지 하려면 맨 아래 dryRun: true 를 false 로 바꾸세요(주의: 되돌리기 어려움).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { submitSenderNumber } = require('./nhnBot');

const DESKTOP = path.join(os.homedir(), 'Desktop');

// 로그를 콘솔 + 파일(nhn/shots/last-run.log)에 함께 남긴다 (붙여넣기 없이 확인용)
const LOG_PATH = path.join(__dirname, 'shots', 'last-run.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
fs.writeFileSync(LOG_PATH, '');
function log(...args) {
  const line = args.join(' ');
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) {
    /* ignore */
  }
}

submitSenderNumber({
  phone: '02-793-2649',
  dryRun: true,
  headless: false, // 창을 보면서 진행 상황 확인
  log,
  files: {
    telecomProof: path.join(DESKTOP, '로컬모티브 통신서비스 가입증명원.png'),
    consent: path.join(DESKTOP, '로컬모티브 이용승낙서.jpg'),
    bizReg: path.join(DESKTOP, '로컬모티브 사업자등록증.jpg'),
    contract: path.join(DESKTOP, '로컬모티브 계약서.jpg'),
    employmentCert: path.join(DESKTOP, '로컬모티브 재직증명서.jpg')
  }
})
  .then((r) => {
    log('\n결과: ' + JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    log('\n실패: ' + e.message);
    log('nhn/shots/error.png 를 확인하면 어디서 멈췄는지 볼 수 있어요.');
    process.exit(1);
  });
