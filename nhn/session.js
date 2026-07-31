'use strict';

// NHN 콘솔 로그인 세션을 "영속 브라우저 프로필"로 관리한다.
//
// 왜 이렇게 하나:
//   기존 방식은 로그인 순간의 쿠키를 nhn-session.json 스냅샷으로 한 번 저장하고,
//   봇이 매번 그 얼어붙은 쿠키만 읽어 썼다. NHN 세션은 사용할 때마다 갱신되는
//   롤링(rolling) 방식이라, 봇이 새 쿠키를 받아도 다시 저장하지 않아 세션이
//   연장되지 않고 캡처 시점부터 시간이 지나면 반드시 만료됐다.
//
//   영속 프로필(userDataDir)을 쓰면 로그인 상태가 폴더에 살아있고, 실행할 때마다
//   NHN이 갱신하는 쿠키가 자동으로 다시 저장돼 세션이 계속 앞으로 굴러간다.
//   (주기 조회가 세션 워밍업 역할도 하게 됨)

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, 'nhn-profile');

// 영속 프로필로 브라우저 컨텍스트를 연다. 반환값은 BrowserContext (browser 아님).
// 닫을 때는 context.close() 를 호출하면 되고, 그 시점에 갱신된 쿠키가 디스크에 반영된다.
async function launchSession({ headless = false } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1360, height: 900 },
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled']
  });
}

// 로그인 프로필이 준비돼 있는지(= capture-session.js를 한 번이라도 돌렸는지) 대략 확인.
// 실제 로그인 만료 여부는 화면 진입 실패로 판별하고, 그때 재캡처를 안내한다.
function hasSession() {
  return fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0;
}

// 같은 프로세스(서버) 안에서 NHN 브라우저가 동시에 두 개 뜨지 않도록 직렬화한다.
// 영속 프로필은 한 번에 하나의 브라우저만 열 수 있어(프로필 잠금), 제출과 주기조회가
// 겹치면 충돌한다. 이 락으로 앞 작업이 끝난 뒤에 다음 작업이 실행되도록 순서를 보장한다.
let chain = Promise.resolve();
function withNhnLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

module.exports = { PROFILE_DIR, launchSession, hasSession, withNhnLock };
