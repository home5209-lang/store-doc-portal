'use strict';

// NHN 발신번호 심사 결과 조회 봇 (Playwright).
// - 저장된 로그인 세션(nhn-session.json)을 재사용해 콘솔의 "발신번호 목록"을 읽는다.
// - 각 발신번호의 상태(등록완료 / 반려 / 심사중)와 반려 사유를 스크래핑해서 반환한다.
// - NHN은 공식 API가 없어 콘솔 화면을 긁는 방식이므로, 화면 구조가 바뀌면
//   `node nhn/syncStatus.js probe` 로 목록 화면을 덤프해 셀렉터를 다시 맞춘다.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PROJECT_URL =
  'https://console.nhncloud.com/project/01WUQd24/notification/sms#preregistration-outgoing-numbers';
const SESSION_PATH = path.join(__dirname, 'nhn-session.json');
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

// 발신번호 목록 표가 들어있는 프레임을 찾는다 (교차출처 iframe).
async function findListFrame(page, log, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let best = null;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        const txt = await f.evaluate(() => document.body ? document.body.innerText : '');
        if (/발신번호/.test(txt)) {
          const rows = await f.locator('tr, [role="row"]').count().catch(() => 0);
          if (!best || rows > best.rows) best = { frame: f, rows };
        }
      } catch (e) {
        /* frame detached */
      }
    }
    if (best) return best.frame;
    await page.waitForTimeout(600);
  }
  throw new Error(
    '발신번호 목록 화면을 찾지 못했습니다. (로그인 세션 만료 또는 화면 구조 변경) — node nhn/capture-session.js 로 세션 재저장 후 다시 시도하세요.'
  );
}

// 프레임 안에서 표의 각 행을 읽어 {phone, statusText, rowText} 배열을 만든다.
async function readRows(frame) {
  return frame.evaluate(() => {
    const rowsEls = Array.from(document.querySelectorAll('tr, [role="row"]'));
    const out = [];
    for (const r of rowsEls) {
      const text = (r.innerText || '').replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    }
    return out;
  });
}

// 반환: [{ phone, status, reason, raw }]
async function scrapeStatuses({ headless = true, log = console.log } = {}) {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('로그인 세션이 없습니다. 먼저 `node nhn/capture-session.js` 를 실행해 세션을 저장하세요.');
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();
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
      // 반려 사유(있으면): 행 텍스트에서 번호/상태 키워드 뒤 남은 부분을 후보로 (best-effort)
      let reason = null;
      if (status === 'rejected') {
        reason = raw
          .replace(/0\d{1,3}[-\s]?\d{3,4}[-\s]?\d{4}/, '')
          .replace(/(반려|거부|거절|실패|반송)/, '')
          .replace(/\s+/g, ' ')
          .trim() || null;
      }
      results.push({ phone, status, reason, raw });
    }
    log(`· 목록에서 ${results.length}건의 발신번호 상태를 읽었습니다.`);
    return results;
  } finally {
    await browser.close();
  }
}

// 화면 구조 확인용: 목록 프레임의 텍스트/HTML/스크린샷을 shots/ 에 덤프
async function probe({ headless = false, log = console.log } = {}) {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('로그인 세션이 없습니다. 먼저 `node nhn/capture-session.js` 를 실행하세요.');
  }
  const dir = shotDir();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();
  try {
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
    const frame = await findListFrame(page, log);
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
    await browser.close();
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
