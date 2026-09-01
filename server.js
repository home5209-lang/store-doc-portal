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
  nhnRequestedAt,
  addAudit,
  listAudit,
  lastActorByStore,
  userStats,
  storesSubmittedByUser,
  userNameByEmail,
  markApproveNotified
} = require('./db');
const { findContractCandidates, downloadSignedPdf } = require('./contractStub');
const { fetchShopBySeq, searchShops } = require('./catchtableAdmin');
const { generateConsentDoc, generateEmploymentCert } = require('./docGenerator');
const { generateUploadToken, verifyUploadToken } = require('./tokens');
const googleAuth = require('./authGoogle');
const { notifySlack } = require('./notify');
const { withNhnLock, hasSession } = require('./nhn/session');
const { businessDaysElapsed } = require('./nhn/bizdays');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.json({ limit: '8mb' })); // 서명(dataURL) 전송용 여유 한도
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets'))); // 양식 배경 이미지 등

const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const GENERATED_ROOT = path.join(__dirname, 'generated');
const TEMPLATES_ROOT = path.join(__dirname, 'templates');

// 매장이 직접 작성해 올릴 서류의 빈 양식(다운로드용). kind → 파일명
const FORM_TEMPLATES = {
  consent: '전화번호이용승낙서_template.docx',
  employment: '재직증명서_template.docx'
};

// 서류 표시 이름을 "{매장명} {서류종류}" 로 통일한다 (다운로드/미리보기/NHN 업로드 파일명이 명확해짐).
const DOC_LABEL = {
  [DOC_TYPES.TELECOM_PROOF]: '통신서비스 이용증명원',
  [DOC_TYPES.BIZ_REG]: '사업자등록증',
  [DOC_TYPES.CONTRACT]: '이용계약서',
  [DOC_TYPES.CONSENT]: '이용승낙서',
  [DOC_TYPES.EMPLOYMENT_CERT]: '재직증명서'
};
function cleanName(s) {
  // 파일명에 못 쓰는 문자 제거 + 공백/밑줄 정리 (한글은 유지)
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
function docFileName(store, docType, ext) {
  const label = DOC_LABEL[docType] || '서류';
  const storeName = cleanName((store && store.name) || '매장') || '매장';
  const e = ext && ext.startsWith('.') ? ext : `.${ext || 'pdf'}`;
  return `${storeName} ${label}${e}`;
}

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
  res.render('upload', { store, docTypes: DOC_TYPES, error: null, token });
});

// 사용승낙서/재직증명서: 매장이 브라우저에서 작성 + 손서명 → PDF 생성·첨부 (AJAX)
app.post('/upload/:storeId/:token/sign/:kind', async (req, res) => {
  const { storeId, token, kind } = req.params;
  const check = verifyUploadToken(storeId, token);
  if (!check.valid) {
    return res.status(check.reason === 'expired' ? 410 : 403).json({ ok: false, error: '링크가 만료되었습니다.' });
  }
  if (kind !== 'consent' && kind !== 'employment') {
    return res.status(404).json({ ok: false, error: '알 수 없는 서류입니다.' });
  }

  const b = req.body || {};
  // 서명(dataURL) → PNG 버퍼
  const m = /^data:image\/png;base64,(.+)$/.exec(String(b.signature || ''));
  const signature = m ? Buffer.from(m[1], 'base64') : null;
  if (!signature) return res.status(400).json({ ok: false, error: '서명이 필요합니다.' });

  // 매장이 입력한 값 저장
  upsertStore({
    id: storeId,
    name: b.name,
    owner_name: b.owner_name,
    biz_reg_no: b.biz_reg_no,
    contact_name: null,
    contact_title: b.contact_title,
    phone_numbers: b.phone_numbers,
    contact_phone: b.contact_phone
  });
  const store = getStore(storeId);

  try {
    if (kind === 'consent') {
      const out = path.join(GENERATED_ROOT, storeId, '사용승낙서.pdf');
      await generateConsentDoc(store, { signature }, out);
      removeDocumentsOfType(storeId, DOC_TYPES.CONSENT);
      addDocument({
        store_id: storeId, doc_type: DOC_TYPES.CONSENT,
        original_name: docFileName(store, DOC_TYPES.CONSENT, '.pdf'), file_path: out, source: 'esign'
      });
    } else {
      const out = path.join(GENERATED_ROOT, storeId, '재직증명서.pdf');
      await generateEmploymentCert(store, {
        signature, birth: b.birth || '', period: b.period || '', issueDate: b.issueDate || ''
      }, out);
      removeDocumentsOfType(storeId, DOC_TYPES.EMPLOYMENT_CERT);
      addDocument({
        store_id: storeId, doc_type: DOC_TYPES.EMPLOYMENT_CERT,
        original_name: docFileName(store, DOC_TYPES.EMPLOYMENT_CERT, '.pdf'), file_path: out, source: 'esign'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 매장용 서류 미리보기 — 방금 서명한 PDF를 토큰으로 인라인 확인
app.get('/upload/:storeId/:token/preview/:kind', (req, res) => {
  const { storeId, token, kind } = req.params;
  const check = verifyUploadToken(storeId, token);
  if (!check.valid) return res.status(403).send('링크가 만료되었습니다.');
  const type = kind === 'consent' ? DOC_TYPES.CONSENT : kind === 'employment' ? DOC_TYPES.EMPLOYMENT_CERT : null;
  if (!type) return res.status(404).send('알 수 없는 서류입니다.');
  const doc = getDocumentsForStore(storeId).find((d) => d.doc_type === type);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).send('아직 작성된 서류가 없습니다.');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
  res.sendFile(path.resolve(doc.file_path));
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

    const { name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers, contact_phone } = req.body;

    // 매장 정보 저장 (서명 단계에서도 저장되지만 최종값 반영)
    upsertStore({ id: storeId, name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers, contact_phone });
    const store = getStore(storeId);

    // 검증: 파일 2종(통신증명원·사업자등록증) + 서명 2종(승낙서·재직증명서 — 앞서 작성·서명으로 첨부됨)
    const docs = getDocumentsForStore(storeId);
    const hasConsent = docs.some((d) => d.doc_type === DOC_TYPES.CONSENT);
    const hasEmployment = docs.some((d) => d.doc_type === DOC_TYPES.EMPLOYMENT_CERT);
    const missing = [];
    if (!req.files?.telecom_proof) missing.push('통신서비스 이용증명원');
    if (!req.files?.biz_reg) missing.push('사업자 등록증');
    if (!hasConsent) missing.push('사용 승낙서(작성·서명)');
    if (!hasEmployment) missing.push('재직 증명서(작성·서명)');
    if (missing.length) {
      return res.render('upload', {
        store,
        docTypes: DOC_TYPES,
        error: `다음 항목을 완료해주세요: ${missing.join(', ')}`,
        token
      });
    }

    // 파일 2종 기록 (재제출 대비 기존 동일 종류는 정리 후 추가)
    const fileUploads = [
      [DOC_TYPES.TELECOM_PROOF, req.files.telecom_proof[0]],
      [DOC_TYPES.BIZ_REG, req.files.biz_reg[0]]
    ];
    for (const [type, file] of fileUploads) {
      removeDocumentsOfType(storeId, type);
      addDocument({
        store_id: storeId,
        doc_type: type,
        original_name: docFileName(store, type, path.extname(file.originalname)),
        file_path: file.path,
        source: 'upload'
      });
    }

    // 계약서(캐치테이블 이용계약서)는 운영자가 /admin 에서 첨부한다.
    markSubmitted(storeId);
    res.render('submitted', { store });
  }
);

// 루트(/) 진입 → 대시보드로. (미로그인 시 requireLogin이 /login으로 보냄)
app.get('/', (req, res) => res.redirect('/admin'));

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
  // 구글 SSO가 아직 설정되지 않았으면 로그인 없이 접근 허용(설정 전 잠김 방지 — 로컬/과도기용)
  if (!googleAuth.isConfigured()) {
    req.user = googleAuth.getSession(req) || { email: null, name: '(로그인 없음)' };
    return next();
  }
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
  const gmail = require('./nhn/gmailReject');
  res.render('admin', {
    stores,
    docTypes: DOC_TYPES,
    createdLink: req.query.created || null,
    linkError: req.query.linkError || null,
    currentUser: req.user,
    lastActor: lastActorByStore(),
    nhnLoggedIn: hasSession(),
    gmailConfigured: gmail.isConfigured(),
    gmailConnected: gmail.isConnected(),
    gmailEmail: gmail.connectedEmail()
  });
});

// 전체 활동 로그 (누가·언제·무엇을·어느 매장). ?user=이메일 이면 그 담당자만.
app.get('/admin/activity', (req, res) => {
  const filterUser = req.query.user || null;
  res.render('activity', {
    entries: listAudit(300, filterUser),
    currentUser: req.user,
    filterUser
  });
});

// 담당자별 사용량 통계
app.get('/admin/members', (req, res) => {
  res.render('members', { stats: userStats(), currentUser: req.user });
});

// 담당자 상세(팝업용 JSON) — 심사 요청 매장 목록 / 활동 로그
app.get('/admin/api/member-stores', (req, res) => {
  const email = req.query.email || '';
  res.json({ ok: true, name: userNameByEmail(email), stores: storesSubmittedByUser(email) });
});
app.get('/admin/api/member-activity', (req, res) => {
  const email = req.query.email || '';
  res.json({ ok: true, name: userNameByEmail(email), entries: listAudit(300, email) });
});

// 담당자 개인 상세 — 그 사람이 심사 요청한 매장들 + 현재 상태 (직접 접속용, 유지)
app.get('/admin/members/:email', (req, res) => {
  const email = req.params.email;
  const stores = storesSubmittedByUser(email);
  res.render('member-detail', {
    email,
    name: userNameByEmail(email),
    stores,
    currentUser: req.user
  });
});

// 매장별 업로드 링크 발급/재발급. storeId가 오면 기존 매장에 새 토큰만 발급하고,
// 없으면 새 매장을 만들고 링크를 발급합니다.
// 매장명/시퀀스로 매장 검색(콤보박스 자동완성용). 브라우저 대신 서버가 내부 API를 호출·캐시한다.
app.get('/admin/shop-lookup', async (req, res) => {
  const q = (req.query.q || req.query.seq || '').trim();
  if (!q) return res.json({ ok: true, items: [] });
  const items = [];
  // 숫자면 시퀀스 직접 조회(전체목록 캐시와 무관하게 항상 동작)
  if (/^\d+$/.test(q)) {
    try {
      const s = await fetchShopBySeq(q);
      items.push({ id: s.id, name: s.name });
    } catch (_) { /* 없으면 무시하고 이름검색으로 */ }
  }
  // 이름/부분검색(전체목록 캐시)
  try {
    const more = await searchShops(q, 20);
    for (const m of more) {
      if (!items.find((x) => String(x.id) === String(m.id))) items.push(m);
    }
  } catch (_) { /* 목록 조회 실패 시 시퀀스 결과만 반환 */ }
  res.json({ ok: true, items: items.slice(0, 20) });
});

app.post('/admin/create-link', async (req, res) => {
  const { name, shop_seq, storeId: existingId } = req.body;
  let storeId = existingId;

  if (storeId) {
    if (!getStore(storeId)) return res.status(404).send('매장을 찾을 수 없습니다.');
  } else {
    let shopName = (name || '').trim();
    const seq = (shop_seq || '').trim();
    // 시퀀스넘버가 있으면 캐치테이블 어드민 API로 매장명을 자동 조회
    if (seq) {
      try {
        const shop = await fetchShopBySeq(seq);
        shopName = shop.name;
      } catch (e) {
        return res.redirect('/admin?linkError=' + encodeURIComponent(e.message));
      }
    }
    storeId = nanoid(8);
    upsertStore({
      id: storeId,
      name: shopName || '매장명 미입력',
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
// 페이지는 즉시 렌더하고(느린 모두싸인 조회를 기다리지 않음), 후보 목록은 아래 /data 에서 비동기로 불러온다.
app.get('/admin/contract-candidates/:storeId', (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  const query = (req.query.q && req.query.q.trim()) || store.name;
  const current = getDocumentsForStore(store.id).find((d) => d.doc_type === DOC_TYPES.CONTRACT) || null;
  res.render('contract-candidates', { store, query, current });
});

// 계약서 후보 목록(JSON) — 모두싸인 조회. 화면이 뜬 뒤 비동기로 호출된다.
app.get('/admin/contract-candidates/:storeId/data', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.json({ ok: false, error: '매장을 찾을 수 없습니다.' });
  const query = (req.query.q && req.query.q.trim()) || store.name;
  try {
    const candidates = await findContractCandidates(query);
    res.json({ ok: true, candidates });
  } catch (err) {
    res.json({ ok: false, error: err.message });
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
    addDocument({
      store_id: store.id,
      doc_type: DOC_TYPES.CONTRACT,
      original_name: docFileName(store, DOC_TYPES.CONTRACT, '.pdf'),
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
    const ext = path.extname(req.file.originalname) || '.pdf';
    addDocument({
      store_id: store.id,
      doc_type: DOC_TYPES.CONTRACT,
      original_name: docFileName(store, DOC_TYPES.CONTRACT, ext),
      file_path: req.file.path,
      source: 'manual:upload'
    });
    addAudit({ user: req.user, action: '계약서 직접 첨부', store, detail: req.file.originalname || '' });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('계약서 직접 첨부 실패: ' + err.message);
  }
});

// 개별 서류 교체("다시 선택") — 해당 서류 종류를 운영자가 올린 파일로 대체한다.
const anyDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(GENERATED_ROOT, req.params.storeId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, `replace_${Date.now()}${ext}`);
    }
  })
});
app.post('/admin/replace-doc/:storeId', anyDocUpload.single('doc_file'), (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).send('매장을 찾을 수 없습니다.');
  const docType = req.body.doc_type;
  if (!Object.values(DOC_TYPES).includes(docType)) return res.status(400).send('알 수 없는 서류 종류입니다.');
  if (!req.file) return res.status(400).send('교체할 파일을 선택해주세요.');
  try {
    removeDocumentsOfType(store.id, docType);
    const ext = path.extname(req.file.originalname) || '.pdf';
    addDocument({
      store_id: store.id,
      doc_type: docType,
      original_name: docFileName(store, docType, ext),
      file_path: req.file.path,
      source: 'manual:replace'
    });
    addAudit({ user: req.user, action: '서류 교체', store, detail: docType });
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('서류 교체 실패: ' + err.message);
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

  // NHN에 올릴 때 쓸 "진짜 파일명" (매장명 + 서류종류). 확장자는 원본 파일 것을 따른다.
  const nameOf = (type) => {
    const p = pathOf(type);
    return docFileName(store, type, p ? path.extname(p) : '.pdf');
  };
  const docNames = {
    telecomProof: nameOf(DOC_TYPES.TELECOM_PROOF),
    consent: nameOf(DOC_TYPES.CONSENT),
    bizReg: nameOf(DOC_TYPES.BIZ_REG),
    contract: nameOf(DOC_TYPES.CONTRACT),
    employmentCert: nameOf(DOC_TYPES.EMPLOYMENT_CERT)
  };

  const realSubmit = String(process.env.NHN_SUBMIT || '').trim() === '1';
  const headless = String(process.env.NHN_HEADLESS || '').trim() === '1';
  const phone = String(store.phone_numbers).split(/[,/\n]/)[0].trim(); // 첫 번호 사용

  try {
    // playwright 미설치 시 서버 기동엔 영향 없도록 지연 로드
    const { submitSenderNumber } = require('./nhn/nhnBot');
    // 제출과 주기조회가 동시에 프로필(브라우저)을 열지 않도록 직렬화
    const result = await withNhnLock(() =>
      submitSenderNumber({ phone, files, docNames, dryRun: !realSubmit, headless })
    );
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

// ── NHN 심사 결과 주기 동기화 (API 기반) ──────────────────────────────────
// NHN Cloud SMS API(sendNos)로 발신번호 상태를 조회한다. 로그인/브라우저 불필요.
//   목록에 있음+blockYn!=Y → registered(승인) / 있음+blockYn=Y → rejected(거부)
//   목록에 없음 → 알 수 없음(심사중 등) → 상태 변경하지 않음
// 승인된 매장의 연락처(업로드 시 입력한 휴대폰)로 문자 발송
async function notifyApproveSms(store, matchedPhone, log = console.log) {
  const { isConfigured, sendSms } = require('./nhn/sendSms');
  if (!isConfigured()) {
    log(`[sms] 발송 설정(SMS_SENDER_NO 등) 없음 — ${store.name} 승인 문자 건너뜀`);
    return;
  }
  const to = store.contact_phone;
  if (!to) {
    log(`[sms] ${store.name} 연락처(contact_phone)가 없어 승인 문자 건너뜀`);
    return;
  }
  const title = '[캐치테이블] 발신번호 등록 완료 안내';
  const text = '\n담당자님.\n신청하신 발신번호 등록이 완료되었습니다.\n이제 해당 번호로 메시지 발송이 가능합니다.\n\n감사합니다.';
  try {
    await sendSms(to, text, title);
    markApproveNotified(store.id);
    log(`[sms] ${store.name} 승인 문자 발송 → ${to}`);
  } catch (e) {
    log(`[sms] ${store.name} 승인 문자 발송 실패: ${e.message}`);
  }
}

let nhnSyncRunning = false;
// 상태 갱신 + 알림(슬랙/문자)을 한곳에서 처리. API 조회·브라우저 스크래핑 양쪽이 공유한다.
// 반환: 실제로 DB를 갱신했으면 true.
function applyStatusUpdate(store, newStatus, reason, matchedPhone, log = console.log) {
  const statusChanged = store.nhn_status !== newStatus;
  if (!statusChanged && !(reason && store.nhn_reject_reason !== reason)) return false;
  setNhnResult(store.id, newStatus, reason);
  log(`[nhn-sync] ${store.name} (${matchedPhone}) → ${newStatus}${reason ? ' / ' + reason : ''}`);
  if (statusChanged && (newStatus === 'registered' || newStatus === 'rejected')) {
    const msg =
      newStatus === 'registered'
        ? `✅ [발신번호 승인/등록완료] ${store.name} · ${matchedPhone}`
        : `🔴 [발신번호 거부] ${store.name} · ${matchedPhone}${reason ? `\n사유: ${reason}` : ''}`;
    notifySlack(msg, log).catch(() => {});
  }
  // 승인(등록완료) 시, 그 매장을 제출한 담당자에게 문자 발송 (중복 방지: approve_notified_at)
  if (statusChanged && newStatus === 'registered' && !store.approve_notified_at) {
    notifyApproveSms(store, matchedPhone, log).catch(() => {});
  }
  return true;
}

// 브라우저 스크래핑 기반 동기화.
//  · NHN sendNos API는 "승인된" 발신번호만 반환해 '거부'는 원리상 감지 불가.
//  · 거부까지 반영하려면 콘솔의 "발신번호 사전등록" 목록 화면을 직접 읽어야 한다.
//  · NHN 로그인(영속 프로필)이 있어야 동작. 없으면 명확한 안내와 함께 실패.
let nhnScrapeRunning = false;
async function runNhnScrapeSync(log = console.log) {
  const { withNhnLock, hasSession } = require('./nhn/session');
  if (!hasSession()) {
    throw new Error('NHN 로그인 세션이 없습니다. 로그인.bat 을 실행해 본인 NHN 계정으로 먼저 로그인하세요.');
  }
  if (nhnScrapeRunning) {
    log('[nhn-scrape] 이전 조회가 아직 진행 중 — 건너뜀');
    return { skipped: true };
  }
  nhnScrapeRunning = true;
  try {
    const { scrapeStatuses } = require('./nhn/syncStatus');
    const headless = String(process.env.NHN_HEADLESS || '') === '1';
    // 제출 봇과 같은 프로필을 쓰므로 락으로 직렬화(동시에 브라우저 두 개 방지)
    const results = await withNhnLock(() => scrapeStatuses({ headless, log }));
    let matched = 0;
    let updated = 0;
    for (const r of results) {
      const store = findStoreByPhone(r.phone);
      if (!store) continue;
      matched += 1;
      if (applyStatusUpdate(store, r.status, r.reason, r.phone, log)) updated += 1;
    }
    log(`[nhn-scrape] 완료: ${results.length}행 읽음, ${matched}건 매칭, ${updated}건 갱신`);
    return { ok: true, rows: results.length, matched, updated };
  } finally {
    nhnScrapeRunning = false;
  }
}

async function runNhnSync(log = console.log) {
  if (nhnSyncRunning) {
    log('[nhn-sync] 이전 조회가 아직 진행 중 — 건너뜀');
    return { skipped: true };
  }
  nhnSyncRunning = true;
  try {
    const { fetchByNumber, isConfigured } = require('./nhn/apiStatus');
    if (!isConfigured()) {
      log('[nhn-sync] NHN_SMS_APPKEY/SECRETKEY 미설정 — 건너뜀');
      return { skipped: true, reason: 'no-keys' };
    }

    let updated = 0;
    let checked = 0;
    for (const store of listStores()) {
      if (!store.phone_numbers) continue;
      const digitsList = String(store.phone_numbers)
        .split(/[,/\n;]/)
        .map((p) => p.replace(/[^0-9]/g, ''))
        .filter(Boolean);
      if (!digitsList.length) continue;

      // 번호를 콕 집어 조회(계정 발신번호가 많아도 누락 없음)
      let newStatus = null;
      let reason = null;
      let matchedPhone = null;
      for (const d of digitsList) {
        checked += 1;
        // eslint-disable-next-line no-await-in-loop
        const hit = await fetchByNumber(d).catch((e) => {
          log(`[nhn-sync] ${store.name} (${d}) 조회 오류: ${e.message}`);
          return undefined; // 오류는 '판정 불가'로 처리(상태 유지)
        });
        if (hit) {
          matchedPhone = d;
          if (hit.blockYn === 'Y') { newStatus = 'rejected'; reason = hit.blockReason || null; }
          else { newStatus = 'registered'; }
          break;
        }
      }
      // API 목록에 승인으로 안 뜬 경우:
      //   NHN 사전등록 반려는 API로 감지 불가(목록에서 빠짐) — 실측 확인됨.
      //   그래서 "반려"로 단정하지 않고, 영업일이 충분히 지나도 승인이 확인되지 않으면
      //   '승인 미확인(unconfirmed)' 으로 표기해 담당자가 직접 확인하도록 안내한다.
      //   NHN은 주말·공휴일에 심사를 안 하므로 "영업일"로 계산.
      //   (유예: NHN_UNCONFIRMED_AFTER_BIZDAYS 영업일, 기본 1 / 0이면 즉시)
      if (!newStatus && store.nhn_status === 'requested') {
        const graceDays = Math.max(0, parseInt(process.env.NHN_UNCONFIRMED_AFTER_BIZDAYS ?? '1', 10) || 0);
        const reqAt = nhnRequestedAt(store.id); // 'YYYY-MM-DD HH:MM:SS' (로컬시각)
        const reqDate = reqAt ? new Date(reqAt.replace(' ', 'T')) : null;
        const elapsed = reqDate ? businessDaysElapsed(reqDate, new Date()) : Infinity;
        if (elapsed >= graceDays) {
          newStatus = 'unconfirmed';
          reason = null;
          matchedPhone = digitsList[0];
        }
      }
      if (!newStatus) continue;

      if (applyStatusUpdate(store, newStatus, reason, matchedPhone, log)) updated += 1;
    }
    log(`[nhn-sync] 완료: 번호 ${checked}건 조회, ${updated}건 갱신`);
    return { ok: true, checked, updated };
  } finally {
    nhnSyncRunning = false;
  }
}

// 수동 조회 (관리자 화면의 "상태 새로고침" 버튼)
//  · API 방식 — 로그인/브라우저 불필요. 승인은 API로, 거부는 "미승인 유예 경과" 자동 판정.
app.post('/admin/nhn-sync', async (req, res) => {
  try {
    await runNhnSync();
    res.redirect('/admin');
  } catch (e) {
    const hint = '\n\n.env 의 NHN_SMS_APPKEY / NHN_SMS_SECRETKEY 값을 확인하세요. (NHN 콘솔 → SMS → URL & Appkey)';
    res.status(500).send('NHN 상태 조회 실패: ' + e.message + hint);
  }
});

// (선택) 정밀 조회 — NHN 콘솔 화면을 직접 읽어 거부 "사유"까지 가져온다. NHN 로그인 필요.
//  자동거부(유예 판정)로 충분하면 안 써도 됨. 사유 원문이 필요할 때만 사용.
app.post('/admin/nhn-scrape', async (req, res) => {
  try {
    await runNhnScrapeSync();
    res.redirect('/admin');
  } catch (e) {
    const hint =
      '\n\n이 기능은 NHN 로그인이 필요합니다. 로그인.bat 을 실행해 본인 NHN 계정으로 로그인한 뒤 다시 시도하세요.';
    res.status(500).send('NHN 정밀 조회 실패: ' + e.message + hint);
  }
});

// ── 반려 메일(Gmail) 연동 ────────────────────────────────
// NHN 반려 사유는 메일로만 오므로, 연동한 메일함에서 반려 메일을 읽어 "거부 + 사유"로 반영.

// 반려 메일을 읽어 매장 상태를 갱신. dryRun=true면 DB에 쓰지 않고 결과만 반환(검증용).
async function runRejectMailSync({ dryRun = false, log = console.log } = {}) {
  const gmail = require('./nhn/gmailReject');
  const { parseRejectEmail, matchStore } = require('./nhn/rejectMail');
  if (!gmail.isConnected()) return { skipped: true, reason: 'not-connected' };

  const mails = await gmail.fetchRejectMails({ newerThanDays: 60 });
  const stores = listStores();
  const results = [];
  let updated = 0;
  for (const mail of mails) {
    const parsed = parseRejectEmail(mail);
    if (!parsed.isReject) continue;
    const m = matchStore(parsed, stores);
    const row = {
      subject: mail.subject,
      maskedNumber: parsed.maskedNumber,
      reason: parsed.reason,
      matched: m ? m.store.name : null,
      by: m ? m.by : null
    };
    results.push(row);
    if (m && parsed.reason && !dryRun) {
      if (applyStatusUpdate(m.store, 'rejected', parsed.reason, parsed.maskedNumber, log)) updated += 1;
    }
  }
  log(`[reject-mail] 반려메일 ${results.length}건, 매칭 ${results.filter((r) => r.matched).length}건${dryRun ? ' (드라이런)' : `, 갱신 ${updated}건`}`);
  return { ok: true, count: results.length, updated, results };
}

// Gmail 연동 시작 (관리자가 gmail.readonly 권한 허용)
app.get('/admin/gmail/connect', (req, res) => {
  const gmail = require('./nhn/gmailReject');
  if (!gmail.isConfigured()) return res.status(400).send('GOOGLE_CLIENT_ID/SECRET 가 필요합니다.');
  const crypto = require('crypto');
  const state = crypto.randomBytes(16).toString('hex');
  googleAuth.parseCookies(req); // noop (쿠키 유틸 로드)
  res.setHeader('Set-Cookie', `sdp_gmail_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.redirect(gmail.getConnectUrl(state));
});

// Gmail 연동 콜백 → refresh token 저장
app.get('/admin/gmail/callback', async (req, res) => {
  const gmail = require('./nhn/gmailReject');
  const { code, state } = req.query;
  const cookieState = (googleAuth.parseCookies(req) || {})['sdp_gmail_state'];
  if (!code || !state || state !== cookieState) {
    return res.status(400).send('연동 검증 실패(state 불일치). 다시 시도해주세요.');
  }
  try {
    const { email } = await gmail.exchangeAndStore(code);
    res.redirect('/admin?gmail=connected&email=' + encodeURIComponent(email || ''));
  } catch (e) {
    res.status(500).send('Gmail 연동 실패: ' + e.message);
  }
});

// 반려 메일 드라이런 — DB에 쓰지 않고 파싱·매칭 결과만 JSON으로 확인 (검증용)
app.get('/admin/gmail/test', async (req, res) => {
  try {
    const out = await runRejectMailSync({ dryRun: true });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 반려 메일 실제 반영 (버튼/수동)
app.post('/admin/gmail/sync', async (req, res) => {
  try {
    await runRejectMailSync({ dryRun: false });
    res.redirect('/admin');
  } catch (e) {
    res.status(500).send('반려 메일 동기화 실패: ' + e.message);
  }
});

app.get('/admin/download/:storeId/:docId', (req, res) => {
  const docs = getDocumentsForStore(req.params.storeId);
  const doc = docs.find((d) => String(d.id) === req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).send('파일을 찾을 수 없습니다.');
  res.download(doc.file_path, doc.original_name);
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
  console.log(
    String(process.env.NHN_SUBMIT || '').trim() === '1'
      ? '⚠️  NHN 실제 제출 모드: ON (버튼 클릭 시 실제 심사 요청까지 제출됩니다)'
      : 'NHN 실제 제출 모드: OFF (드라이런 — 제출 직전까지만). 실제 제출하려면 NHN_SUBMIT=1로 시작하세요.'
  );

  // NHN 심사 결과 자동 주기 동기화.
  //  · NHN_SYNC=0 이면 끔 / NHN_SYNC_INTERVAL_MIN 으로 주기(분) 조정 (기본 180분)
  //  · 로그인 프로필(nhn/nhn-profile)이 있을 때만 동작
  //  · 조회 시 브라우저 창이 잠깐 떴다 닫힘(정상). 창이 거슬리면 NHN_SYNC=0 으로 끄고 수동 새로고침만 사용.
  const syncEnabled = process.env.NHN_SYNC !== '0';
  const { isConfigured: nhnApiReady } = require('./nhn/apiStatus');
  if (syncEnabled && nhnApiReady()) {
    const minutes = Math.max(5, parseInt(process.env.NHN_SYNC_INTERVAL_MIN || '30', 10) || 30);
    console.log(`NHN 심사 상태 자동 조회(API): ${minutes}분마다 실행`);
    const tick = () => {
      runNhnSync().catch((e) => console.error('[nhn-sync] 오류:', e.message));
      // Gmail 연동돼 있으면 반려 메일도 함께 반영 (거부 + 사유)
      runRejectMailSync({ dryRun: false }).catch((e) => console.error('[reject-mail] 오류:', e.message));
    };
    setTimeout(tick, 5000); // 기동 5초 후 1회
    setInterval(tick, minutes * 60 * 1000);
  } else if (syncEnabled && !nhnApiReady()) {
    console.log('NHN 자동 조회 대기: .env 에 NHN_SMS_APPKEY/SECRETKEY 넣고 재기동하면 켜집니다.');
  }

  // 모두싸인 계약서 목록 캐시를 백그라운드로 미리 채운다(서명자 검색·오래된 문서용).
  //  · 오픈 API가 서명자 검색을 지원하지 않아, 완료문서 전체를 받아 로컬에서 매칭한다.
  //  · 첫 로딩은 문서가 많으면 시간이 걸리므로, 클릭을 막지 않게 백그라운드로 예열한다.
  try {
    const { warmContractCache, getModusignCredentials } = require('./contractStub');
    const creds = getModusignCredentials();
    if (creds && creds.email && creds.apiKey) {
      console.log('모두싸인 계약서 목록 캐시 예열 시작(백그라운드)…');
      warmContractCache()
        .then(() => console.log('모두싸인 계약서 캐시 준비 완료'))
        .catch(() => {});
      setInterval(() => { warmContractCache(); }, 30 * 60 * 1000); // 30분마다 갱신
    }
  } catch (e) {
    /* 모듈 로드 실패 시 무시 */
  }
});
