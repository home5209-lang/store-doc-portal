'use strict';

// NHN 콘솔 로그인 세션을 영속 프로필(nhn-profile/)에 저장하는 스크립트.
// 실행: node nhn/capture-session.js
//   → 브라우저가 열리면 NHN Cloud에 직접 로그인하고,
//     터미널에서 Enter를 누르면 로그인 상태가 nhn-profile/ 프로필에 저장된다.
//   이후 봇(nhnBot.js)·조회(syncStatus.js)가 이 프로필을 재사용하며,
//   실행할 때마다 쿠키가 자동 갱신돼 세션이 계속 유지된다.
//   (완전히 만료되면 이 스크립트를 다시 실행해 재로그인)
//
//   ⚠️ 서버가 켜져 있으면 프로필이 잠겨 있어 이 스크립트가 실패할 수 있다.
//      먼저 서버를 끈 뒤(taskkill /F /IM node.exe) 실행하세요.

const { launchSession, PROFILE_DIR } = require('./session');

(async () => {
  const context = await launchSession({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://console.nhncloud.com/');

  console.log('\n==============================================');
  console.log(' 브라우저에서 NHN Cloud 콘솔에 로그인하세요.');
  console.log(' 로그인을 "완전히" 끝낸 뒤(프로젝트 화면이 보이면),');
  console.log(' 이 터미널로 돌아와 Enter 키를 누르면 세션이 저장됩니다.');
  console.log(' (미리 붙여넣은 다른 명령은 무시되니 안심하세요.)');
  console.log('==============================================\n');

  // 붙여넣기 등으로 "미리" 들어온 입력(예: 다음에 실행할 명령)이 로그인 전에
  // Enter로 오인돼 세션이 조기 저장되는 사고를 막는다.
  // → 시작 직후 잠깐(2초) 동안 들어오는 stdin 데이터는 버리고, 그 이후의 Enter만 인정한다.
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const ignoreUntil = Date.now() + 2000;
  await new Promise((resolve) => {
    process.stdin.on('data', () => {
      if (Date.now() < ignoreUntil) return; // 초기 버퍼(붙여넣은 명령들) 무시
      resolve();
    });
  });

  await context.close(); // 닫는 시점에 로그인 쿠키가 프로필에 반영됨
  console.log('\n세션 저장 완료 →', PROFILE_DIR);
  process.exit(0);
})().catch((e) => {
  const msg = String(e && e.message);
  if (/SingletonLock|ProcessSingleton|already (in use|running)|EBUSY|locked/i.test(msg)) {
    console.error(
      '오류: 프로필이 사용 중입니다. 서버가 켜져 있으면 먼저 끄세요 → taskkill /F /IM node.exe\n원인:',
      msg
    );
  } else {
    console.error('오류:', msg);
  }
  process.exit(1);
});
