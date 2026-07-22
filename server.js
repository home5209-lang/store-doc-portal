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
  markSubmitted
} = require('./db');
const { generateConsentDoc, generateEmploymentCert } = require('./docGenerator');
const { fetchContractFromModusign } = require('./contractStub');
const { generateUploadToken, verifyUploadToken } = require('./tokens');
const { requireAdminAuth } = require('./auth');

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

    const { name, owner_name, biz_reg_no, contact_name, contact_title } = req.body;

    if (!req.files?.telecom_proof || !req.files?.biz_reg) {
      const store = getStore(storeId);
      return res.render('upload', {
        store,
        docTypes: DOC_TYPES,
        error: '통신서비스 이용증명원과 사업자 등록증을 모두 첨부해주세요.'
      });
    }

    // 1. 매장 정보 저장
    upsertStore({ id: storeId, name, owner_name, biz_reg_no, contact_name, contact_title });
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

    // 3. 계약서 자동 첨부 (모두싸인 API 연동)
    // 매장명으로 모두싸인에서 서명 완료 문서를 찾아 실제 PDF를 받아온다.
    // 매칭에 실패하면 .txt 안내 파일이 대신 생성된다 (운영자 수동 확인용).
    const contractBasePath = path.join(GENERATED_ROOT, storeId, '캐치테이블_이용계약서.pdf');
    const contractResult = await fetchContractFromModusign(store, contractBasePath);
    const contractFinalPath = contractResult.matched ? contractResult.path : contractBasePath.replace(/\.pdf$/i, '.txt');
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.CONTRACT,
      original_name: path.basename(contractFinalPath),
      file_path: contractFinalPath,
      source: contractResult.matched ? 'auto:modusign' : 'auto:modusign-failed'
    });

    // 4. 사용승낙서 / 재직증명서 자동 생성
    const consentPath = path.join(GENERATED_ROOT, storeId, '사용승낙서.docx');
    await generateConsentDoc(store, consentPath);
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.CONSENT,
      original_name: '사용승낙서.docx',
      file_path: consentPath,
      source: 'auto:generated'
    });

    const certPath = path.join(GENERATED_ROOT, storeId, '재직증명서.docx');
    await generateEmploymentCert(store, certPath);
    addDocument({
      store_id: storeId,
      doc_type: DOC_TYPES.EMPLOYMENT_CERT,
      original_name: '재직증명서.docx',
      file_path: certPath,
      source: 'auto:generated'
    });

    markSubmitted(storeId);
    res.render('submitted', { store });
  }
);

// -------------------------------------------------------------------------
// 관리자용: 매장별 진행 현황 + 서류 다운로드
// ADMIN_USER / ADMIN_PASS 환경변수로 로그인해야 접근 가능 (Basic Auth)
// -------------------------------------------------------------------------
app.use('/admin', requireAdminAuth);

app.get('/admin', (req, res) => {
  const stores = listStores().map((s) => ({
    ...s,
    documents: getDocumentsForStore(s.id)
  }));
  res.render('admin', { stores, docTypes: DOC_TYPES, createdLink: req.query.created || null });
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
  res.redirect(`/admin?created=${encodeURIComponent(url)}`);
});

app.get('/admin/download/:storeId/:docId', (req, res) => {
  const docs = getDocumentsForStore(req.params.storeId);
  const doc = docs.find((d) => String(d.id) === req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).send('파일을 찾을 수 없습니다.');
  res.download(doc.file_path, doc.original_name);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`store-doc-portal listening on http://localhost:${PORT}`);
  const sampleId = nanoid(8);
  const sampleToken = generateUploadToken(sampleId);
  console.log(`샘플 업로드 링크: http://localhost:${PORT}/upload/${sampleId}/${sampleToken}`);
});
