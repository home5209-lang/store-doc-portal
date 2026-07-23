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
    const fileInputs = frame.locator('input[type=file]');
    const count = await fileInputs.count();
    log('   iframe 내 file input 개수:', count);

    // 각 file input이 속한 섹션(제목)을 파악 (순번이 아니라 섹션명으로 매칭하기 위함)
    const sectionOf = [];
    for (let i = 0; i < count; i += 1) {
      sectionOf[i] = await fileInputs
        .nth(i)
        .evaluate((el) => {
          let node = el.parentElement;
          for (let k = 0; k < 10 && node; k += 1) {
            const txt = (node.innerText || '').replace(/\s+/g, ' ').trim();
            const m = txt.match(/통신서비스 이용증명원|이용승낙서|타사 사업자등록증|관계 확인 문서|기타 서류/);
            if (m) return m[0];
            node = node.parentElement;
          }
          return '(미상)';
        })
        .catch(() => '(?)');
      log(`   [진단] input[${i}] → ${sectionOf[i]}`);
    }

    // 섹션명 → 파일 매핑 (순번 무관)
    const wanted = [
      ['통신서비스 이용증명원', files.telecomProof],
      ['이용승낙서', files.consent],
      ['타사 사업자등록증', files.bizReg],
      ['관계 확인 문서', files.contract],
      ['기타 서류', files.employmentCert]
    ];

    // 한 섹션에 input이 여러 개면(숨은 중복 포함) '보이는' 것을 우선, 없으면 마지막 것 선택
    async function pickIndex(sectionName) {
      const idxs = [];
      for (let i = 0; i < count; i += 1) if (sectionOf[i] === sectionName) idxs.push(i);
      for (const i of idxs) {
        const vis = await fileInputs.nth(i).isVisible().catch(() => false);
        if (vis) return i;
      }
      return idxs.length ? idxs[idxs.length - 1] : -1;
    }

    for (const [sectionName, filePath] of wanted) {
      const idx = await pickIndex(sectionName);
      if (idx >= 0) {
        await fileInputs.nth(idx).setInputFiles(filePath);
        log(`   · ${sectionName} ← ${path.basename(filePath)} (input[${idx}])`);
      } else {
        log(`   ! '${sectionName}' 칸을 찾지 못했습니다`);
      }
    }

    await page.waitForTimeout(1000);
    await shot(page, '2-files-attached', log);

    if (dryRun) {
      log('\n✅ DRY-RUN 완료 — "발신번호 등록 심사 요청" 직전에서 멈췄습니다.');
      log('   nhn/shots/ 폴더의 스크린샷으로 번호/서류가 잘 채워졌는지 확인하세요.');
      return { ok: true, dryRun: true };
    }

    log('7) 발신번호 등록 심사 요청 (실제 제출)');
    await frame.getByRole('button', { name: /발신번호 등록 심사 요청/ }).click();
    await page.waitForTimeout(3000);
    await shot(page, '3-submitted', log);
    return { ok: true, submitted: true };
  } catch (e) {
    await shot(page, 'error', log);
    throw e;
  } finally {
    await browser.close();
  }
}

module.exports = { submitSenderNumber };
