'use strict';

// NHN 발신번호 심사 결과 조회 봇 (Playwright).
// - 저장된 로그인 세션(nhn-session.json)을 재사용해 콘솔의 "발신번호 목록"을 읽는다.
// - 각 발신번호의 상태(등록완료 / 반려 / 심사중)와 반려 사유를 스크래핑해서 반환한다.
// - NHN은 공식 API가 없어 콘솔 화면을 긁는 방식이므로, 화면 구조가 바뀌면
//   `node nhn/syncStatus.js probe` 로 목록 화면을 덤프해 셀렉터를 다시 맞춘다.

const path = require('path');
const fs = require('fs');
const { launchSession, hasSession } = require('./session');

const PROJECT_URL =
  'https://console.nhncloud.com/project/01WUQd24/notification/sms#preregistration-outgoing-numbers';
const SHOT_DIR = path.join(__dirname, 'shots');

// 상태 텍스트 → 내부 상태코드
function classifyStatus(text) {
  const t = String(text || '');
  if (/(반려|거부|거절|실패|반송)/.test(t)) return 'rejected';
  if (/(등록\s*완료|등록완료|승인\s*완료|승인완료|사용\s*가능|정상|승인)/.test(t)) return 'registered';
  if (/(심사|검수|대기|접수|요청|진행)/.test(t)) return 'requested';
  return null;
}

// 문자열에서 전화번호 후보(숫자 9~12자리, 0으로 시작)를 뽑아 숫자만 반환
function extractPhone(text) {
  const m = String(text || '').match(/0\d{1,3}[-\s]?\d{3,4}[-\s]?\d{4}/);
  if (m) return m[0].replace(/[^0-9]/g, '');
  const digits = String(text || '').replace(/[^0-9]/g, '');
  return /^0\d{8,11}$/.test(digits) ? digits : null;
}

function shotDir() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return SHOT_DIR;
}

// 발신번호 목록이 들어있는 콘솔 콘텐츠 iframe을 찾는다.
// NHN 콘솔은 실제 화면을 교차출처 iframe(#productIframe, url에 sender-phone-number-verification
// 또는 address-book 포함)에 담는다. 바깥 네비게이션 프레임이 아니라 이 안쪽 프레임을 잡아야 한다.
async function findListFrame(page, log, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    // 1순위: URL로 콘텐츠 iframe 식별
    const byUrl = frames.find((f) =>
      /sender-phone-number-verification|address-book/.test(f.url() || '')
    );
    if (byUrl) return byUrl;
    // 2순위: 최상위가 아니면서 발신번호 관련 텍스트가 있는 프레임
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      try {
        const txt = await f.evaluate(() => (document.body ? document.body.innerText : ''));
        if (/발신번호|전화번호/.test(txt)) return f;
      } catch (e) {
        /* cross-origin/detached */
      }
    }
    await page.waitForTimeout(600);
  }
  throw new Error(
    '발신번호 목록 화면(콘텐츠 iframe)을 찾지 못했습니다. (로그인 세션 만료 또는 화면 구조 변경) — node nhn/capture-session.js 로 세션 재저장 후 다시 시도하세요.'
  );
}

// 프레임 안에서 "발신번호 등록 요청 내역" 표의 데이터 행 텍스트 배열을 만든다.
// 화면에는 표가 여러 개(서류 안내표 등) 있으므로, 헤더에 "상태" 컬럼이 있는 표
// (= 요청 내역 표: 번호 종류 / 번호 / 상태 / 인증 요청 일시 / 인증 일시)만 고른다.
async function readRows(frame) {
  return frame.evaluate(() => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table'));
    // "상태" 헤더가 있는 표 우선 선택
    let target = null;
    for (const tb of tables) {
      const headText = norm(
        Array.from(tb.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'))
          .map((c) => c.innerText)
          .join(' ')
      );
      if (/상태/.test(headText) && /번호/.test(headText)) {
        target = tb;
        break;
      }
    }
    const out = [];
    const seen = new Set();
    const push = (t) => {
      const s = norm(t);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    };
    if (target) {
      const bodyRows = target.querySelectorAll('tbody tr');
      const rows = bodyRows.length ? Array.from(bodyRows) : Array.from(target.querySelectorAll('tr')).slice(1);
      for (const r of rows) {
        const txt = norm(r.innerText);
        if (!txt || /요청 내역이 없습니다|총 0건/.test(txt)) continue;
        push(txt);
      }
      return out; // 요청 내역 표를 찾았으면 (비어있어도) 이걸로 확정
    }
    // 폴백: 상태 표를 못 찾은 경우 모든 tr / 그리드 행
    for (const sel of ['tbody tr', 'tr', '[role="row"]', '.grid-row', '.list-row']) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) {
        for (const el of els) push(el.innerText);
        if (out.length) return out;
      }
    }
    return out;
  });
}

// 반환: [{ phone, status, reason, raw }]
async function scrapeStatuses({ headless = true, log = console.log } = {}) {
  if (!hasSession()) {
    throw new Error('로그인 세션이 없습니다. 먼저 `node nhn/capture-session.js` 를 실행해 세션을 저장하세요.');
  }
  const context = await launchSession({ headless });
  const page = context.pages()[0] || (await context.newPage());
  try {
    log('· NHN 콘솔 발신번호 목록으로 이동...');
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
    const frame = await findListFrame(page, log);
    await page.waitForTimeout(1200); // 표 렌더 대기

    const rawRows = await readRows(frame);
    const results = [];
    for (const raw of rawRows) {
      const phone = extractPhone(raw);
      const status = classifyStatus(raw);
      if (!phone || !status) continue;
      // 반려 사유(있으면): 행에서 번호/상태/번호종류/날짜를 걷어낸 나머지를 후보로 (best-effort).
      // 요청 내역 표에는 별도 사유 컬럼이 없어 대개 비게 되며, 그 경우 null.
      let reason = null;
      if (status === 'rejected') {
        reason =
          raw
            .replace(/0\d{1,3}[-\s]?\d{3,4}[-\s]?\d{4}/g, '')
            .replace(/(반려|거부|거절|실패|반송)/g, '')
            .replace(/(사업자|법인|대표자|임직원|타사|타인)\s*(명의)?\s*번호/g, '')
            .replace(/\d{4}[-.]\d{2}[-.]\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/g, '') // 날짜/시각
            .replace(/서류 인증/g, '')
            .replace(/[|·\-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || null;
      }
      results.push({ phone, status, reason, raw });
    }
    log(`· 목록에서 ${results.length}건의 발신번호 상태를 읽었습니다.`);
    return results;
  } finally {
    await context.close();
  }
}

// 화면 구조 확인용: 목록 프레임의 텍스트/HTML/스크린샷을 shots/ 에 덤프
async function probe({ headless = false, log = console.log } = {}) {
  if (!hasSession()) {
    throw new Error('로그인 세션이 없습니다. 먼저 `node nhn/capture-session.js` 를 실행하세요.');
  }
  const dir = shotDir();
  const context = await launchSession({ headless });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500); // 콘솔 iframe 로딩 대기
    // 진단: 모든 프레임 URL 기록
    const frameUrls = page.frames().map((f) => f.url());
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frameUrls, null, 2), 'utf8');
    log(`프레임 ${frameUrls.length}개:`);
    frameUrls.forEach((u) => log('   · ' + u));
    const frame = await findListFrame(page, log);
    log('선택된 프레임 URL: ' + frame.url());
    await page.waitForTimeout(1500);
    const text = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
    const html = await frame.content();
    fs.writeFileSync(path.join(dir, 'list-text.txt'), text, 'utf8');
    fs.writeFileSync(path.join(dir, 'list-page.html'), html, 'utf8');
    await page.screenshot({ path: path.join(dir, 'list-page.png'), fullPage: true });
    const rows = await readRows(frame);
    fs.writeFileSync(path.join(dir, 'list-rows.json'), JSON.stringify(rows, null, 2), 'utf8');
    log('덤프 완료 → nhn/shots/list-text.txt, list-page.html, list-page.png, list-rows.json');
    log(`행 후보 ${rows.length}개.`);
  } finally {
    await context.close();
  }
}

module.exports = { scrapeStatuses, probe, classifyStatus, extractPhone };

// CLI: `node nhn/syncStatus.js`        → 상태 스크래핑 결과를 콘솔에 출력
//      `node nhn/syncStatus.js probe`  → 목록 화면 덤프
if (require.main === module) {
  const mode = process.argv[2];
  const headless = process.env.NHN_HEADLESS === '1';
  (async () => {
    try {
      if (mode === 'probe') {
        await probe({ headless });
      } else {
        const rows = await scrapeStatuses({ headless });
        console.log(JSON.stringify(rows, null, 2));
      }
    } catch (e) {
      console.error('실패:', e.message);
      process.exit(1);
    }
  })();
}
