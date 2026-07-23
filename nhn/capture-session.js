'use strict';

// NHN 콘솔 로그인 세션을 한 번만 저장해두는 스크립트.
// 실행: node nhn/capture-session.js
//   → 브라우저가 열리면 NHN Cloud에 직접 로그인하고,
//     터미널에서 Enter를 누르면 로그인 세션이 nhn/nhn-session.json 에 저장된다.
//   이후 봇(nhnBot.js)이 이 세션을 재사용하므로 매번 로그인/CAPTCHA를 거치지 않는다.
//   (세션은 만료될 수 있으니, 봇이 로그인 화면으로 튕기면 이 스크립트를 다시 실행)

const path = require('path');
const { chromium } = require('playwright');

const SESSION_PATH = path.join(__dirname, 'nhn-session.json');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://console.nhncloud.com/');

  console.log('\n==============================================');
  console.log(' 브라우저에서 NHN Cloud 콘솔에 로그인하세요.');
  console.log(' 로그인 완료(프로젝트 화면이 보이면) 후,');
  console.log(' 이 터미널에서 Enter 키를 누르면 세션이 저장됩니다.');
  console.log('==============================================\n');

  await new Promise((resolve) => process.stdin.once('data', resolve));

  await context.storageState({ path: SESSION_PATH });
  console.log('\n세션 저장 완료 →', SESSION_PATH);
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('오류:', e.message);
  process.exit(1);
});
