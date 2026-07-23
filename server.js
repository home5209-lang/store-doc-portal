require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');

const {
  DOC_TYPES,
  upsertStore,
  getStore,
  listStores,
  addDocument,
  getDocumentsForStore,
  removeDocumentsOfType,
  markSubmitted,
  setNhnStatus,
  setNhnResult,
  findStoreByPhone,
  addAudit,
  listAudit,
  lastActorByStore
} = require('./db');
const { generateConsentDoc, generateEmploymentCert } = require('./docGenerator');
const { findContractCandidates, downloadSignedPdf } = require('./contractStub');
const { generateUploadToken, verifyUploadToken } = require('./tokens');
const googleAuth = require('./authGoogle');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const GENERATED_ROOT = path.join(__dirname, 'generated');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, req.params.storeId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-가-힣]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

// -------------------------------------------------------------------------
// 매장용 업로드 링크
// storeId만으로는 접근할 수 없고, 만료 시각이 서명으로 묶인 토큰이 함께 있어야 열립니다.
// 링크는 /admin 화면에서 매장별로 발급/재발급합니다.
// -------------------------------------------------------------------------
app.get('/upload/:storeId/:token', (req, res) => {
  const { storeId, token } = req.params;
  const check = verifyUploadToken(storeId, token);
  if (!check.valid) {
    return res.status(check.reason === 'expired' ? 410 : 403).render('link-invalid', { reason: check.reason });
  }

  let store = getStore(storeId);
  if (!store) {
    // 토큰은 유효한데 매장 레코드가 없으면(예: DB 초기화) 임시 레코드를 만들어 둡니다.
    upsertStore({
      id: storeId,
      name: '매장명 미입력',
      owner_name: '',
      biz_reg_no: '',
      contact_name: '',
      contact_title: ''
    });
    store = getStore(storeId);
  }
  res.render('upload', { store, docTypes: DOC_TYPES, error: null });
});

app.post(
  '/upload/:storeId/:token',
  upload.fields([
    { name: 'telecom_proof', maxCount: 1 },
    { name: 'biz_reg', maxCount: 1 }
  ]),
  async (req, res) => {
    const { storeId, token } = req.params;
    const check = verifyUploadToken(storeId, token);
    if (!check.valid) {
      return res.status(check.reason === 'expired' ? 410 : 403).render('link-invalid', { reason: check.reason });
    }

    const { name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers } = req.body;

    if (!req.files?.telecom_proof || !req.files?.biz_reg) {
      const store = getStore(storeId);
      return res.render('upload', {
        store,
        docTypes: DOC_TYPES,
        error: '통신서비스 이용증명원과 사업자 등록증을 모두 첨부해주세요.'
      });
    }

    // 1. 매장 정보 저장
    upsertStore({ id: storeId, name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers });
    const store = getStore(storeId);

    // 2. 매장이 직접 올린 서류 2건 기록
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.TELECOM_PROOF,
      original_name: req.files.telecom_proof[0].originalname,
      file_path: req.files.telecom_proof[0].path,
      source: 'upload'
    });
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.BIZ_REG,
      original_name: req.files.biz_reg[0].originalname,
      file_path: req.files.biz_reg[0].path,
      source: 'upload'
    });

    // 3. 계약서는 자동 첨부하지 않는다.
    // 한 매장에 계약서가 여러 종류(광고/이용계약서/합의서 등)라 자동 선택이 불안정하므로,
    // 운영자가 /admin 에서 모두싸인 후보 목록을 보고 직접 선택해 첨부한다.
    // (아래 GET /admin/contract-candidates, POST /admin/attach-contract 참고)

    // 4. 사용승낙서 / 재직증명서 자동 생성 (PDF — 심사 제출용)
    const consentPath = path.join(GENERATED_ROOT, storeId, '사용승낙서.pdf');
    await generateConsentDoc(store, consentPath);
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.CONSENT,
      original_name: '사용승낙서.pdf',
      file_path: consentPath,
      source: 'auto:generated'
    });

    const certPath = path.join(GENERATED_ROOT, storeId, '재직증명서.pdf');
    await generateEmploymentCert(store, certPath);
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.EMPLOYMENT_CERT,
      original_name: '재직증명서.pdf',
      file_path: certPath,
      source: 'auto:generated'
    });

    markSubmitted(storeId);
    res.render('submitted', { store });
  }
);

// -------------------------------------------------------------------------
// 로그인 (구글/회사 SSO) — catchtable.co.kr 계정만 허용
// -------------------------------------------------------------------------
app.get('/login', (req, res) => {
  if (googleAuth.getSession(req)) return res.redirect('/admin');
  res.render('login', {
    configured: googleAuth.isConfigured(),
    domain: googleAuth.ALLOWED_DOMAIN,
    error: req.query.error || null
  });
});

app.get('/auth/google', (req, res) => {
  if (!googleAuth.isConfigured()) {
    return res.redirect('/login?error=' + encodeURIComponent('구글 로그인이 설정되지 않았습니다. 관리자에게 문의하세요.'));
  }
  res.redirect(googleAuth.getAuthUrl(res));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/login?error=' + encodeURIComponent(String(error)));
  if (!code || !googleAuth.checkState(req, state)) {
    return res.redirect('/login?error=' + encodeURIComponent('로그인 요청이 유효하지 않습니다. 다시 시도해주세요.'));
  }
  try {
    const user = await googleAuth.exchangeCodeForUser(code);
    googleAuth.setSession(res, user);
    addAudit({ user, action: '로그인' });
    res.redirect('/admin');
  } catch (e) {
    res.redirect('/login?error=' + encodeURIComponent(e.message));
  }
});

app.get('/auth/logout', (req, res) => {
  googleAuth.clearSession(res);
  res.redirect('/login');
});

// -------------------------------------------------------------------------
// 관리자용: 로그인 세션 필요 (미로그인 시 로그인 페이지로)
// -------------------------------------------------------------------------
function requireLogin(req, res, next) {
  const user = googleAuth.getSession(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.method === 'GET') return res.redirect('/login');
  return res.status(401).send('로그인이 필요합니다.');
}
app.use('/admin', requireLogin);

app.get('/admin', (req, res) => {
  const stores = listStores().map((s) => ({
    ...s,
    documents: getDocumentsForStore(s.id)
  }));
  res.render('admin', {
    stores,
    docTypes: DOC_TYPES,
    createdLink: req.query.created || null,
    currentUser: req.user,
    lastActor: lastActorByStore()
  });
});

// 전체 활동 로그 (누가·언제·무엇을·어느 매장)
app.get('/admin/activity', (req, res) => {
  res.render('activity', { entries: listAudit(300), currentUser: req.user });
});

// 매장별 업로드 링크 발급/재발급. storeId가 오면 기존 매장에 새 토큰만 발급하고,
// 없으면 새 매장을 만들고 링크를 발급합니다.
app.post('/admin/create-link', (req, res) => {
  const { name, storeId: existingId } = req.body;
  let storeId = existingId;

  if (storeId) {
    if (!getStore(storeId)) return res.status(404).send('매장을 찾을 수 없습니다.');
  } else {
    storeId = nanoid(8);
    upsertStore({
      id: storeId,
      name: name || '매장명 미입력',
      owner_name: '',
      biz_reg_no: '',
      contact_name: '',
      contact_title: ''
    });
  }

  const token = generateUploadToken(storeId);
  const url = `${req.protocol}://${req.get('host')}/upload/${storeId}/${token}`;
  addAudit({ user: req.user, action: existingId ? '업로드 링크 재발급' : '업로드 링크 발급', store: getStore(storeId) });
  res.redirect(`/admin?created=${encodeURIComponent(url)}`);
});

// 매장별 모두싸인 계약서 "후보" 목록 — 운영자가 직접 선택 (없으면 직접 업로드도 가능)
app.get('/admin/contract-candidates/:storeId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  // 기본 검색어는 매장명. 오타/표기 차이가 있으면 운영자가 q로 바꿔 다시 검색할 수 있다.
  const query = (req.query.q && req.query.q.trim()) || store.name;
  const current = getDocumentsForStore(store.id).find((d) => d.doc_type === DOC_TYPES.CONTRACT) || null;
  try {
    const candidates = await findContractCandidates(query);
    res.render('contract-candidates', { store, query, candidates, current, error: null });
  } catch (err) {
    res.render('contract-candidates', { store, query, candidates: [], current, error: err.message });
  }
});

// 선택한 계약서를 내려받아 매장 계약서로 첨부 (기존 계약서는 교체)
app.post('/admin/attach-contract/:storeId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  const { documentId, title } = req.body;
  if (!documentId) return res.status(400).send('documentId가 필요합니다.');
  try {
    const outPath = path.join(GENERATED_ROOT, store.id, '캐치테이블_이용계약서.pdf');
    await downloadSignedPdf(documentId, outPath);
    // 기존 계약서가 있으면 교체 (단건 유지)
    removeDocumentsOfType(store.id, DOC_TYPES.CONTRACT);
    const safeTitle = (title || '캐치테이블_이용계약서').replace(/[^\w.\-가-힣 ]/g, '_').trim();
    addDocument({
      store_id: store.id,
      doc_type: DOC_TYPES.CONTRACT,
      original_name: `${safeTitle || '캐치테이블_이용계약서'}.pdf`,
      file_path: outPath,
      source: 'manual:modusign'
    });
    addAudit({ user: req.user, action: '계약서 첨부(모두싸인)', store, detail: title || '' });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('계약서 첨부 실패: ' + err.message);
  }
});

// 계약서 직접 업로드 첨부 — 모두싸인에 없는 계약서를 운영자가 파일로 직접 올린다.
const contractUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(GENERATED_ROOT, req.params.storeId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, `계약서_직접첨부${ext}`);
    }
  })
});
app.post('/admin/attach-contract-file/:storeId', contractUpload.single('contract_file'), (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  if (!req.file) return res.status(400).send('첨부할 계약서 파일을 선택해주세요.');
  try {
    removeDocumentsOfType(store.id, DOC_TYPES.CONTRACT); // 기존 계약서 교체 (단건 유지)
    const safeName = (req.file.originalname || '계약서_직접첨부.pdf').replace(/[^\w.\-가-힣 ]/g, '_').trim();
    addDocument({
      store_id: store.id,
      doc_type: DOC_TYPES.CONTRACT,
      original_name: safeName || '계약서_직접첨부.pdf',
      file_path: req.file.path,
      source: 'manual:upload'
    });
    addAudit({ user: req.user, action: '계약서 직접 첨부', store, detail: safeName });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('계약서 직접 첨부 실패: ' + err.message);
  }
});

// 운영자 검토 후 NHN 발신번호 등록 신청 — Playwright 봇(nhn/nhnBot.js)이 콘솔을 자동 조작.
//  · 기본: 드라이런(제출 직전까지만) — 안전
//  · 환경변수 NHN_SUBMIT=1 일 때만 실제 "발신번호 등록 심사 요청" 제출
//  · 사전 준비: `node nhn/capture-session.js` 로 NHN 로그인 세션 저장
app.post('/admin/nhn-submit/:storeId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');

  const docs = getDocumentsForStore(store.id);
  const pathOf = (type) => {
    const d = docs.find((x) => x.doc_type === type);
    return d ? d.file_path : null;
  };
  // NHN "타사 번호" 서류 칸 ↔ 매장 서류 매핑
  const files = {
    telecomProof: pathOf(DOC_TYPES.TELECOM_PROOF), // 통신서비스 이용증명원
    consent: pathOf(DOC_TYPES.CONSENT), // 이용승낙서
    bizReg: pathOf(DOC_TYPES.BIZ_REG), // 타사 사업자등록증
    contract: pathOf(DOC_TYPES.CONTRACT), // 관계 확인 문서(이용계약서)
    employmentCert: pathOf(DOC_TYPES.EMPLOYMENT_CERT) // 기타 서류(재직증명서)
  };
  const missing = Object.entries(files)
    .filter(([, p]) => !p || !fs.existsSync(p))
    .map(([k]) => k);
  if (missing.length) {
    return res.status(400).send('서류가 모두 준비되지 않았습니다: ' + missing.join(', '));
  }
  if (!store.phone_numbers) {
    return res.status(400).send('발신번호가 없습니다. 업로드 폼에서 발신번호를 입력받아야 합니다.');
  }

  const realSubmit = process.env.NHN_SUBMIT === '1';
  const headless = process.env.NHN_HEADLESS === '1';
  const phone = String(store.phone_numbers).split(/[,/\n]/)[0].trim(); // 첫 번호 사용

  try {
    // playwright 미설치 시 서버 기동엔 영향 없도록 지연 로드
    const { submitSenderNumber } = require('./nhn/nhnBot');
    const result = await submitSenderNumber({ phone, files, dryRun: !realSubmit, headless });
    if (realSubmit && result && result.submitted) {
      setNhnStatus(store.id, 'requested');
      addAudit({ user: req.user, action: 'NHN 등록 신청(실제 제출)', store, detail: phone });
    } else {
      addAudit({ user: req.user, action: 'NHN 등록 신청(드라이런)', store, detail: phone });
    }
    res.redirect('/admin');
  } catch (e) {
    const hint = /세션|session|storageState|nhn-session/.test(e.message)
      ? '\n\nNHN 로그인 세션 문제일 수 있어요 → 터미널에서 `node nhn/capture-session.js` 재실행 후 다시 시도하세요.'
      : '\n\nnhn/shots/error.png 스크린샷으로 어디서 멈췄는지 확인할 수 있어요.';
    res.status(500).send('NHN 자동화 실패: ' + e.message + hint);
  }
});

// ── NHN 심사 결과 주기 동기화 ──────────────────────────────────────────────
// NHN은 API가 없어 콘솔의 "발신번호 목록"을 봇이 읽어와 매장별 상태를 갱신한다.
// 상태: requested(심사중) → registered(등록완료) / rejected(반려, 사유 포함)
let nhnSyncRunning = false;
async function runNhnSync(log = console.log) {
  if (nhnSyncRunning) {
    log('[nhn-sync] 이전 조회가 아직 진행 중 — 건너뜀');
    return { skipped: true };
  }
  nhnSyncRunning = true;
  try {
    const { scrapeStatuses } = require('./nhn/syncStatus');
    const headless = process.env.NHN_HEADLESS !== '0'; // 주기 동기화는 기본 headless
    const rows = await scrapeStatuses({ headless, log });
    let updated = 0;
    for (const r of rows) {
      const store = findStoreByPhone(r.phone);
      if (!store) continue;
      if (store.nhn_status !== r.status || (r.reason && store.nhn_reject_reason !== r.reason)) {
        setNhnResult(store.id, r.status, r.reason);
        updated += 1;
        log(`[nhn-sync] ${store.name} (${r.phone}) → ${r.status}${r.reason ? ' / ' + r.reason : ''}`);
      }
    }
    log(`[nhn-sync] 완료: ${rows.length}건 조회, ${updated}건 갱신`);
    return { ok: true, scanned: rows.length, updated };
  } finally {
    nhnSyncRunning = false;
  }
}

// 수동 조회 (관리자 화면의 "상태 새로고침" 버튼)
app.post('/admin/nhn-sync', async (req, res) => {
  try {
    await runNhnSync();
    res.redirect('/admin');
  } catch (e) {
    const hint = /세션|session|storageState|nhn-session/.test(e.message)
      ? '\n\nNHN 로그인 세션 문제일 수 있어요 → 터미널에서 `node nhn/capture-session.js` 재실행 후 다시 시도하세요.'
      : '\n\n화면 구조가 바뀌었을 수 있어요 → `node nhn/syncStatus.js probe` 로 목록 화면을 덤프해 확인하세요.';
    res.status(500).send('NHN 상태 조회 실패: ' + e.message + hint);
  }
});

app.get('/admin/download/:storeId/:docId', (req, res) => {
  const docs = getDocumentsForStore(req.params.storeId);
  const doc = docs.find((d) => String(d.id) === req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).send('파일을 찾을 수 없습니다.');
  res.download(doc.file_path, doc.original_name);
});

// 사용승낙서·재직증명서 재생성 — 저장된 매장 정보로 다시 만든다(양식/로직 변경 후 갱신용).
app.post('/admin/regenerate-docs/:storeId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  try {
    const consentPath = path.join(GENERATED_ROOT, store.id, '사용승낙서.pdf');
    await generateConsentDoc(store, consentPath);
    removeDocumentsOfType(store.id, DOC_TYPES.CONSENT);
    addDocument({ store_id: store.id, doc_type: DOC_TYPES.CONSENT, original_name: '사용승낙서.pdf', file_path: consentPath, source: 'auto:generated' });

    const certPath = path.join(GENERATED_ROOT, store.id, '재직증명서.pdf');
    await generateEmploymentCert(store, certPath);
    removeDocumentsOfType(store.id, DOC_TYPES.EMPLOYMENT_CERT);
    addDocument({ store_id: store.id, doc_type: DOC_TYPES.EMPLOYMENT_CERT, original_name: '재직증명서.pdf', file_path: certPath, source: 'auto:generated' });

    console.log(`[재생성] ${store.name} 승낙서/재직증명서 다시 생성 완료`);
    addAudit({ user: req.user, action: '서류 재생성', store });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('서류 재생성 실패: ' + err.message);
  }
});

// 계약서 후보 미리보기 — 첨부 전에 모두싸인 완료 PDF를 내려받아 인라인으로 보여준다.
app.get('/admin/candidate-preview/:storeId/:documentId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  try {
    const tmpPath = path.join(GENERATED_ROOT, store.id, '_preview', `${req.params.documentId}.pdf`);
    await downloadSignedPdf(req.params.documentId, tmpPath);
    res.setHeader('Content-Disposition', 'inline; filename="contract-preview.pdf"');
    res.sendFile(path.resolve(tmpPath));
  } catch (err) {
    res.status(500).send('계약서 미리보기 실패: ' + err.message);
  }
});

// 서류 미리보기 — 브라우저에서 인라인으로 열기(PDF/이미지는 미리보기, 그 외는 다운로드).
app.get('/admin/view/:storeId/:docId', (req, res) => {
  const docs = getDocumentsForStore(req.params.storeId);
  const doc = docs.find((d) => String(d.id) === req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).send('파일을 찾을 수 없습니다.');
  res.setHeader('Cache-Control', 'no-store, must-revalidate'); // 재생성 후 옛 파일 캐시 방지
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(doc.original_name || 'file') + '"');
  res.sendFile(path.resolve(doc.file_path)); // 확장자로 Content-Type 자동 설정 → 브라우저가 미리보기
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`store-doc-portal listening on http://localhost:${PORT}`);
  const sampleId = nanoid(8);
  const sampleToken = generateUploadToken(sampleId);
  console.log(`샘플 업로드 링크: http://localhost:${PORT}/upload/${sampleId}/${sampleToken}`);

  // NHN 심사 결과 자동 주기 동기화.
  //  · NHN_SYNC=0 이면 끔 / NHN_SYNC_INTERVAL_MIN 으로 주기(분) 조정 (기본 180분)
  //  · 로그인 세션(nhn/nhn-session.json)이 있을 때만 동작
  const syncEnabled = process.env.NHN_SYNC !== '0';
  const sessionExists = fs.existsSync(path.join(__dirname, 'nhn', 'nhn-session.json'));
  if (syncEnabled && sessionExists) {
    const minutes = Math.max(10, parseInt(process.env.NHN_SYNC_INTERVAL_MIN || '30', 10) || 30);
    console.log(`NHN 심사 상태 자동 조회: ${minutes}분마다 실행`);
    const tick = () => runNhnSync().catch((e) => console.error('[nhn-sync] 오류:', e.message));
    setTimeout(tick, 15000); // 기동 15초 후 1회
    setInterval(tick, minutes * 60 * 1000);
  } else if (syncEnabled && !sessionExists) {
    console.log('NHN 자동 조회 대기: 로그인 세션이 없어요 → `node nhn/capture-session.js` 실행 후 재기동하면 켜집니다.');
  }
});
