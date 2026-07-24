'use strict';

// NHN 발신번호 사전등록 자동 제출 봇 (Playwright).
// - 저장된 로그인 세션(nhn-session.json)을 재사용
// - 발신번호 사전등록 폼(다른 출처 iframe)에 접근 → 번호 종류/발신번호 입력 → 서류 5종 업로드
// - dryRun=true 면 "발신번호 등록 심사 요청" 직전에 멈추고 스크린샷만 남김 (안전 검증용)
//
// files 매핑 (타사 번호 기준 NHN 서류 칸):
//   telecomProof   → 통신서비스 이용증명원
//   consent        → 이용승낙서 (사용승낙서)
//   bizReg         → 타사 사업자등록증
//   contract       → 관계 확인 문서 (이용계약서)
//   employmentCert → 기타 서류 (재직증명서)

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// NHN 업로더는 파일명이 비정상(매장이 올린 한글 깨짐 → 초장문 밑줄 이름)이면 첨부를 거부한다.
// 그래서 업로드 전에 모든 파일을 "짧고 깨끗한 ASCII 이름"으로 준비한다(prepareUpload).
//  - 이미지(png/jpg): 흰 배경에 합쳐 알파 제거한 baseline JPG로 재인코딩 (크로미움 canvas 사용)
//  - 그 외(pdf 등): 깨끗한 이름으로 복사만
function safeBase(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
async function prepareUpload(context, filePath, key, niceName) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const ext = path.extname(filePath).toLowerCase();
  // 업로드 파일명: "{매장명} {서류종류}" (niceName). 없으면 key로 대체. 이미지→.jpg, 그 외→원본 확장자.
  const base = safeBase((niceName || `up_${key}`).replace(/\.[^.]+$/, '')) || `up_${key}`;
  if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const out = path.join(SHOT_DIR, `${base}.jpg`);
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const b64 = fs.readFileSync(filePath).toString('base64');
    const p = await context.newPage();
    try {
      await p.setContent(`<img id="i" src="data:${mime};base64,${b64}">`);
      await p.evaluate(
        () =>
          new Promise((res) => {
            const img = document.getElementById('i');
            if (img && img.complete && img.naturalWidth) res();
            else if (img) img.onload = () => res();
            else res();
          })
      );
      const jpeg = await p.evaluate(() => {
        const img = document.getElementById('i');
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        return c.toDataURL('image/jpeg', 0.92);
      });
      fs.writeFileSync(out, Buffer.from(jpeg.split(',')[1], 'base64'));
      return out;
    } finally {
      await p.close().catch(() => {});
    }
  }
  // pdf 등: "{매장명} {서류종류}" 이름으로 복사
  const out = path.join(SHOT_DIR, `${base}${ext || '.pdf'}`);
  fs.copyFileSync(filePath, out);
  return out;
}

const PROJECT_URL =
  'https://console.nhncloud.com/project/01WUQd24/notification/sms#preregistration-outgoing-numbers';
const SESSION_PATH = path.join(__dirname, 'nhn-session.json');
const SHOT_DIR = path.join(__dirname, 'shots');

function shotPath(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, `${name}.png`);
}
async function shot(page, name, log) {
  const p = shotPath(name);
  try {
    await page.screenshot({ path: p, fullPage: true });
    log('  · 스크린샷:', p);
  } catch (e) {
    /* ignore */
  }
}

// 실패해도 흐름을 끊지 않고 경고만 남기는 시도 헬퍼
async function attempt(fn, log, label) {
  try {
    await fn();
  } catch (e) {
    log(`   경고(${label}):`, String(e.message).split('\n')[0]);
  }
}

// 발신번호 등록 UI가 들어있는 (iframe) 프레임을 찾는다.
async function findContentFrame(page, log, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        const hit = await f.getByText('발신번호 등록 및 서류 인증하기').count();
        if (hit > 0) return f;
      } catch (e) {
        /* frame detached, ignore */
      }
    }
    await page.waitForTimeout(600);
  }
  throw new Error(
    '발신번호 등록 화면을 찾지 못했습니다. (로그인 세션 만료 또는 화면 구조 변경 가능) — capture-session.js로 세션을 다시 저장해보세요.'
  );
}

async function submitSenderNumber({
  phone,
  files,
  docNames = {},
  dryRun = true,
  headless = false,
  log = console.log
}) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) throw new Error('발신번호(phone)가 비어 있습니다.');

  const required = ['telecomProof', 'consent', 'bizReg', 'contract', 'employmentCert'];
  for (const k of required) {
    if (!files || !files[k]) throw new Error(`파일 누락: ${k}`);
    if (!fs.existsSync(files[k])) throw new Error(`파일이 존재하지 않습니다: ${files[k]}`);
  }
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('로그인 세션이 없습니다. 먼저 `node nhn/capture-session.js`를 실행해 세션을 저장하세요.');
  }

  const orderedFiles = [
    files.telecomProof, // 통신서비스 이용증명원
    files.consent, // 이용승낙서
    files.bizReg, // 타사 사업자등록증
    files.contract, // 관계 확인 문서
    files.employmentCert // 기타 서류
  ];

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  try {
    // 0) 모든 서류를 "짧고 깨끗한 이름"으로 준비 (매장 업로드 파일명이 깨져서 NHN이 거부하는 문제 해결)
    log('0) 서류 파일명 정리 + 이미지 변환');
    const resolved = {};
    for (const k of Object.keys(files)) {
      // eslint-disable-next-line no-await-in-loop
      resolved[k] = await prepareUpload(context, files[k], k, docNames[k]).catch(() => files[k]);
      log(`   (${k} → ${path.basename(resolved[k])})`);
    }

    log('1) NHN 콘솔로 이동...');
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });

    const frame = await findContentFrame(page, log);
    log('2) 발신번호 등록 화면 진입 → 등록 버튼 클릭');
    await frame.getByText('발신번호 등록 및 서류 인증하기').first().click();

    log('3) 개인정보 수집 동의 → 다음');
    await page.waitForTimeout(1200); // 모달 렌더 대기

    // --- 진단: 모달 안의 체크박스/버튼 구조 파악 ---
    const cbCount = await frame.getByRole('checkbox').count().catch(() => 0);
    const nextByRole = frame.getByRole('button', { name: /다음/ });
    const nextRoleCount = await nextByRole.count().catch(() => 0);
    log(`   [진단] checkbox=${cbCount}, 다음(button role)=${nextRoleCount}`);

    // 동의 체크박스 체크 (여러 방식 방어적으로)
    if (cbCount > 0) {
      await attempt(() => frame.getByRole('checkbox').first().check({ timeout: 5000 }), log, '체크박스 check');
    } else {
      // 커스텀 체크박스: '동의' 텍스트/주변을 클릭
      await attempt(() => frame.getByText('동의', { exact: true }).first().click({ timeout: 5000 }), log, '동의 텍스트 클릭');
    }
    await page.waitForTimeout(600);

    // 다음 버튼: 활성화 여부 로깅 후 클릭 (role → 텍스트 폴백)
    if (nextRoleCount > 0) {
      const enabled = await nextByRole.first().isEnabled().catch(() => null);
      log('   [진단] 다음 버튼 enabled =', enabled);
      await nextByRole.first().click({ timeout: 10000 });
    } else {
      log('   [진단] button role "다음" 없음 → 텍스트로 클릭 시도');
      await frame.getByText('다음', { exact: true }).first().click({ timeout: 10000 });
    }

    log('4) 번호 종류 = 타사 번호');
    // 드롭다운 열기: 현재값 '사업자 번호'가 표시된 토글 클릭 (토글 클래스 → 텍스트 폴백)
    const toggle = frame.locator('.dropdown-toggle', { hasText: '사업자 번호' });
    if (await toggle.count()) {
      await attempt(() => toggle.first().click({ timeout: 5000 }), log, '드롭다운 토글');
    } else {
      await attempt(() => frame.getByText('사업자 번호', { exact: true }).first().click({ timeout: 5000 }), log, '드롭다운 열기(텍스트)');
    }
    await page.waitForTimeout(400);
    // 메뉴 항목(.dropdown-item)으로 좁혀서 '타사 번호' 선택 (표의 '타사 번호' 셀들과 구분)
    await frame.locator('.dropdown-item', { hasText: '타사 번호' }).first().click({ timeout: 8000 });

    log('5) 발신번호 입력:', digits);
    await frame.getByPlaceholder(/발신번호/).first().fill(digits);

    await shot(page, '1-form-filled', log);

    log('6) 서류 업로드');
    // NHN 업로더는 각 서류마다 고정된 input id를 쓴다(주변 텍스트 추측보다 정확).
    //   <input type=file id="...Button" class="custom-file-input blind"> + <label for="...">파일선택</label>
    // 타사 번호 필수: 통신서비스 이용증명원 / 이용승낙서 / (타사)사업자등록증 / 관계확인문서
    // (재직증명서 칸은 타사 번호에서 숨김이라 재직증명서는 '기타 서류'에 넣는다)
    const idMap = [
      ['certificateOfCommunicationServiceButton', resolved.telecomProof, '통신서비스 이용증명원'],
      ['consignmentOfUseButton', resolved.consent, '이용승낙서'],
      ['thirdPartyBusinessLicenseButton', resolved.bizReg, '타사 사업자등록증'],
      ['relationShipConfirmationButton', resolved.contract, '관계 확인 문서'],
      ['etcDocumentButton', resolved.employmentCert, '기타 서류(재직증명서)']
    ];
    // 한 서류를 첨부하고, input.files 에 실제로 들어갔는지 확인한다.
    // 연속으로 파일창을 여닫으면 경합(race)으로 일부가 누락되므로, 0이면 최대 3회 재시도한다.
    async function fileCount(input) {
      return input.evaluate((el) => (el.files ? el.files.length : 0)).catch(() => 0);
    }
    async function attachOne(id, filePath, label) {
      const lbl = frame.locator(`label[for="${id}"]`);
      const input = frame.locator(`#${id}`);
      if (!(await input.count().catch(() => 0))) {
        log(`   ! ${label} 첨부칸(#${id})을 찾지 못함`);
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (await lbl.count().catch(() => 0)) {
            // eslint-disable-next-line no-await-in-loop
            await lbl.first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            // eslint-disable-next-line no-await-in-loop
            const [chooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 10000 }),
              lbl.first().click({ timeout: 6000 })
            ]);
            // eslint-disable-next-line no-await-in-loop
            await chooser.setFiles(filePath);
          } else {
            // eslint-disable-next-line no-await-in-loop
            await input.setInputFiles(filePath);
          }
        } catch (e) {
          log(`   경고: ${label} ${attempt}차 첨부 실패 ${String(e.message).split('\n')[0]}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(900); // NHN이 파일을 처리하도록 대기
        // eslint-disable-next-line no-await-in-loop
        const n = await fileCount(input);
        if (n >= 1) {
          log(`   · ${label} ← ${path.basename(filePath)} (${attempt}차 성공)`);
          return;
        }
        log(`   · ${label} 아직 비어있음(${attempt}차) — 재시도`);
      }
      log(`   ! ${label} 3회 시도했으나 첨부 실패`);
    }

    for (const [id, filePath, label] of idMap) {
      // (파일은 0단계에서 이미 변환 완료 — 여기선 임시 페이지를 열지 않아 filechooser 간섭 없음)
      // eslint-disable-next-line no-await-in-loop
      await attachOne(id, filePath, label);
    }

    await page.waitForTimeout(1500); // NHN이 첨부 파일을 인식하도록 잠시 대기
    await shot(page, '2-files-attached', log);

    if (dryRun) {
      log('\n✅ DRY-RUN 완료 — "발신번호 등록 심사 요청" 직전에서 멈췄습니다.');
      log('   nhn/shots/ 폴더의 스크린샷으로 번호/서류가 잘 채워졌는지 확인하세요.');
      return { ok: true, dryRun: true };
    }

    log('7) 서류 인식 확인 + 심사 요청');
    // 진단: 각 필수 서류 input에 파일이 실제로 들어갔는지(NHN이 인식했는지) 확인
    const required = [
      ['certificateOfCommunicationServiceButton', '통신서비스 이용증명원'],
      ['consignmentOfUseButton', '이용승낙서'],
      ['thirdPartyBusinessLicenseButton', '타사 사업자등록증'],
      ['relationShipConfirmationButton', '관계 확인 문서']
    ];
    for (const [id, label] of required) {
      // eslint-disable-next-line no-await-in-loop
      const n = await frame
        .locator(`#${id}`)
        .evaluate((el) => (el.files ? el.files.length : -1))
        .catch(() => -1);
      log(`   [진단] ${label} 첨부 파일수 = ${n}${n === 0 ? '  ← 비어있음(직접 첨부 필요)' : ''}`);
    }

    // 심사요청 버튼(실제 <button>, 서류 다 붙으면 disabled 해제)
    let btn = frame.locator('button', { hasText: '발신번호 등록 심사 요청' });
    if (!(await btn.count())) btn = frame.getByText('발신번호 등록 심사 요청').first();
    await attempt(() => btn.first().scrollIntoViewIfNeeded({ timeout: 5000 }), log, '버튼 스크롤');
    await shot(page, '3-before-submit', log);
    const enabled = await btn.first().isEnabled().catch(() => null);
    log('   [진단] 심사요청 버튼 enabled =', enabled);

    if (enabled) {
      await attempt(() => btn.first().click({ timeout: 8000 }), log, '심사요청 클릭');
      log('   · 심사요청 버튼 클릭함');
    } else {
      log('   ! 심사요청 버튼이 아직 비활성입니다 — 위 "비어있음" 서류를 브라우저 창에서 직접 첨부해주세요.');
    }

    // 반자동: 브라우저를 열어둔 채, 완료 모달이 뜨거나 최대 5분이 지날 때까지 대기.
    // (운영자가 창에서 빈 칸을 직접 첨부하고 "발신번호 등록 심사 요청"을 눌러 마무리할 수 있음)
    log('\n👉 브라우저 창을 확인하세요. 비어있는 서류가 있으면 직접 첨부하고, "발신번호 등록 심사 요청"을 눌러 제출하면 됩니다.');
    log('   (창은 최대 5분간 열려 있으며, 제출이 완료되면 자동 감지 후 닫힙니다.)');
    let submitted = false;
    try {
      await frame.getByText(/심사 요청이 완료되었습니다/).first().waitFor({ timeout: 300000 });
      submitted = true;
      await shot(page, '5-submitted', log);
      log('\n✅ 발신번호 등록 심사 요청 완료가 감지되었습니다.');
    } catch (e) {
      log('\n(5분 내 제출 완료가 감지되지 않았습니다. 창이 곧 닫힙니다 — 필요하면 다시 시도하세요.)');
    }
    return { ok: true, submitted };
  } catch (e) {
    await shot(page, 'error', log);
    throw e;
  } finally {
    await browser.close();
  }
}

module.exports = { submitSenderNumber };
