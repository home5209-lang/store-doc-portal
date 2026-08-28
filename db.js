const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// db 폴더가 없으면 생성 (배포 번들·새 clone 등에서 폴더가 없을 때 대비)
const DB_DIR = path.join(__dirname, 'db');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'portal.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_name TEXT,
    biz_reg_no TEXT,
    contact_name TEXT,
    contact_title TEXT,
    phone_numbers TEXT,
    nhn_status TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    original_name TEXT,
    file_path TEXT,
    source TEXT NOT NULL DEFAULT 'upload',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (store_id) REFERENCES stores(id)
  );

  -- 활동 로그: 누가(user_*) 언제 무엇을(action) 어느 매장(store_*)에 했는지
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT,
    user_name TEXT,
    action TEXT NOT NULL,
    store_id TEXT,
    store_name TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// 기존 DB에 phone_numbers 컬럼이 없으면 추가 (신규 DB는 위 CREATE에 이미 포함)
try {
  db.exec('ALTER TABLE stores ADD COLUMN phone_numbers TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// NHN 발신번호 등록 신청 상태:
//   null(미신청) / 'requested'(신청함·심사중) / 'registered'(등록완료) / 'rejected'(반려)
try {
  db.exec('ALTER TABLE stores ADD COLUMN nhn_status TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// 반려 사유(반려일 때 NHN 콘솔에서 긁어온 텍스트)
try {
  db.exec('ALTER TABLE stores ADD COLUMN nhn_reject_reason TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// 마지막으로 NHN 상태를 조회한 시각
try {
  db.exec('ALTER TABLE stores ADD COLUMN nhn_checked_at TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// 승인(등록완료) 문자 발송 시각 — 중복 발송 방지용
try {
  db.exec('ALTER TABLE stores ADD COLUMN approve_notified_at TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// [마이그레이션] 예전 버전이 자동으로 '거부(rejected)'로 표기한 건(=사유 없음)을
//   새 상태 '승인 미확인(unconfirmed)'으로 되돌린다. 실제 사유가 있는 거부(콘솔에서 확인)는 유지.
try {
  db.exec(
    `UPDATE stores SET nhn_status='unconfirmed'
     WHERE nhn_status='rejected' AND (nhn_reject_reason IS NULL OR nhn_reject_reason='')`
  );
} catch (e) {
  /* 무시 */
}
// 승인 안내 문자를 받을 연락처(매장이 업로드 시 입력)
try {
  db.exec('ALTER TABLE stores ADD COLUMN contact_phone TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}

// 문서 종류는 코드 전체에서 이 5가지 키로 통일해서 다룬다
const DOC_TYPES = {
  TELECOM_PROOF: '통신서비스 이용증명원',
  BIZ_REG: '사업자 등록증',
  CONTRACT: '캐치테이블 이용계약서',
  CONSENT: '사용 승낙서',
  EMPLOYMENT_CERT: '재직 증명서'
};

function upsertStore(store) {
  const existing = db.prepare('SELECT id FROM stores WHERE id = ?').get(store.id);
  if (existing) {
    // 넘어오지 않으면(undefined) 기존 값 보존 (COALESCE)
    db.prepare(
      `UPDATE stores SET name=?, owner_name=?, biz_reg_no=?, contact_name=?, contact_title=?, phone_numbers=COALESCE(?, phone_numbers), contact_phone=COALESCE(?, contact_phone) WHERE id=?`
    ).run(store.name, store.owner_name, store.biz_reg_no, store.contact_name, store.contact_title, store.phone_numbers ?? null, store.contact_phone ?? null, store.id);
  } else {
    db.prepare(
      `INSERT INTO stores (id, name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers, contact_phone) VALUES (?,?,?,?,?,?,?,?)`
    ).run(store.id, store.name, store.owner_name, store.biz_reg_no, store.contact_name, store.contact_title, store.phone_numbers ?? null, store.contact_phone ?? null);
  }
}

function getStore(id) {
  return db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
}

function listStores() {
  return db.prepare('SELECT * FROM stores ORDER BY created_at DESC').all();
}

function addDocument(doc) {
  db.prepare(
    `INSERT INTO documents (store_id, doc_type, original_name, file_path, source) VALUES (?,?,?,?,?)`
  ).run(doc.store_id, doc.doc_type, doc.original_name, doc.file_path, doc.source);
}

function getDocumentsForStore(storeId) {
  return db.prepare('SELECT * FROM documents WHERE store_id = ? ORDER BY created_at').all(storeId);
}

// 특정 종류의 문서를 모두 삭제한다. (예: 계약서를 다시 선택할 때 기존 계약서 교체용)
function removeDocumentsOfType(storeId, docType) {
  db.prepare('DELETE FROM documents WHERE store_id = ? AND doc_type = ?').run(storeId, docType);
}

function markSubmitted(storeId) {
  db.prepare(`UPDATE stores SET status='submitted', submitted_at=datetime('now') WHERE id=?`).run(storeId);
}

// NHN 등록 신청 상태 변경 ('requested' | 'registered' | 'rejected' | null)
function setNhnStatus(storeId, status) {
  db.prepare(`UPDATE stores SET nhn_status=? WHERE id=?`).run(status, storeId);
}

// NHN 심사 결과(주기 조회로 갱신): 상태 + 반려사유 + 조회시각을 함께 반영
function setNhnResult(storeId, status, reason) {
  db.prepare(
    `UPDATE stores SET nhn_status=?, nhn_reject_reason=?, nhn_checked_at=datetime('now') WHERE id=?`
  ).run(status, reason || null, storeId);
}

// 이 매장이 마지막으로 NHN에 등록 신청(심사 요청)한 시각. 활동 로그 기준. 없으면 null.
// (미승인이 일정 시간 지나면 자동으로 '거부'로 판정할 때 경과 시간 계산에 사용)
function nhnRequestedAt(storeId) {
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS at FROM audit_log
       WHERE store_id = ? AND action LIKE 'NHN 등록 신청%'`
    )
    .get(storeId);
  return (row && row.at) || null;
}

// 발신번호(숫자만)로 매장을 찾는다. phone_numbers에 여러 개가 쉼표 등으로 들어있을 수 있어
// 각 매장의 번호들을 정규화해 정확 일치를 찾는다. (주기 동기화에서 스크래핑 결과 매칭용)
function findStoreByPhone(digits) {
  const target = String(digits || '').replace(/[^0-9]/g, '');
  if (!target) return null;
  const rows = db.prepare('SELECT * FROM stores WHERE phone_numbers IS NOT NULL').all();
  return (
    rows.find((s) =>
      String(s.phone_numbers)
        .split(/[,/\n;]/)
        .some((p) => p.replace(/[^0-9]/g, '') === target)
    ) || null
  );
}

// ── 활동 로그 ──────────────────────────────────────────────
function addAudit({ user, action, store, detail }) {
  db.prepare(
    `INSERT INTO audit_log (user_email, user_name, action, store_id, store_name, detail)
     VALUES (?,?,?,?,?,?)`
  ).run(
    (user && user.email) || null,
    (user && user.name) || null,
    action,
    (store && store.id) || null,
    (store && store.name) || null,
    detail || null
  );
}

// 최근 활동 목록 (최신순). userEmail을 주면 그 담당자 것만.
function listAudit(limit = 200, userEmail = null) {
  if (userEmail) {
    return db
      .prepare('SELECT * FROM audit_log WHERE user_email = ? ORDER BY id DESC LIMIT ?')
      .all(userEmail, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

// 담당자별 사용량 통계.
//  - 행동 카운트(제출/링크/계약서/교체/최근활동)는 audit_log 집계
//  - 등록완료/거부는 "그 번호를 제출한 담당자" 기준으로 stores 상태를 귀속
function userStats() {
  const rows = db
    .prepare(
      `SELECT
         COALESCE(user_email,'') AS email,
         MAX(user_name)          AS name,
         SUM(CASE WHEN action LIKE 'NHN 등록 신청%' THEN 1 ELSE 0 END) AS submits,
         SUM(CASE WHEN action LIKE '업로드 링크%'   THEN 1 ELSE 0 END) AS links,
         SUM(CASE WHEN action LIKE '계약서%'        THEN 1 ELSE 0 END) AS contracts,
         SUM(CASE WHEN action = '서류 교체'         THEN 1 ELSE 0 END) AS replaces,
         COUNT(*)                AS total,
         MAX(created_at)         AS last_at
       FROM audit_log
       GROUP BY email`
    )
    .all();

  // 매장별 "제출 담당자"(최신 제출 감사행) → 상태 귀속
  const outcome = db
    .prepare(
      `SELECT sub.email AS email,
         SUM(CASE WHEN s.nhn_status='registered' THEN 1 ELSE 0 END) AS registered,
         SUM(CASE WHEN s.nhn_status='rejected'   THEN 1 ELSE 0 END) AS rejected
       FROM (
         SELECT a.store_id, COALESCE(a.user_email,'') AS email
         FROM audit_log a
         JOIN (SELECT store_id, MAX(id) AS mid
               FROM audit_log
               WHERE action LIKE 'NHN 등록 신청%' AND store_id IS NOT NULL
               GROUP BY store_id) m
           ON a.id = m.mid
       ) sub
       JOIN stores s ON s.id = sub.store_id
       GROUP BY sub.email`
    )
    .all();

  const outMap = {};
  outcome.forEach((o) => { outMap[o.email] = o; });

  return rows
    .map((r) => ({
      email: r.email,
      name: r.name || r.email || '(미상)',
      submits: r.submits || 0,
      links: r.links || 0,
      contracts: r.contracts || 0,
      replaces: r.replaces || 0,
      total: r.total || 0,
      last_at: r.last_at,
      registered: (outMap[r.email] && outMap[r.email].registered) || 0,
      rejected: (outMap[r.email] && outMap[r.email].rejected) || 0
    }))
    .sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
}

// 승인 문자 발송 완료 표시 (중복 방지)
function markApproveNotified(storeId) {
  db.prepare(`UPDATE stores SET approve_notified_at=datetime('now') WHERE id=?`).run(storeId);
}

// 이 매장을 마지막으로 NHN에 제출한 담당자 이메일
function submitterEmailForStore(storeId) {
  const row = db
    .prepare(
      `SELECT COALESCE(user_email,'') AS email
       FROM audit_log
       WHERE store_id = ? AND action LIKE 'NHN 등록 신청%'
       ORDER BY id DESC LIMIT 1`
    )
    .get(storeId);
  return row ? row.email : '';
}

// 특정 담당자가 "NHN 심사 요청(제출)"한 매장 목록 + 현재 상태.
//  - 매장별 최신 제출 감사행의 담당자가 이 사람인 매장만 (userStats 귀속 로직과 동일)
function storesSubmittedByUser(email) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.phone_numbers, s.nhn_status, s.nhn_reject_reason,
              s.nhn_checked_at, s.submitted_at, sub.submitted_log_at
       FROM (
         SELECT a.store_id, COALESCE(a.user_email,'') AS email, a.created_at AS submitted_log_at
         FROM audit_log a
         JOIN (SELECT store_id, MAX(id) AS mid
               FROM audit_log
               WHERE action LIKE 'NHN 등록 신청%' AND store_id IS NOT NULL
               GROUP BY store_id) m
           ON a.id = m.mid
       ) sub
       JOIN stores s ON s.id = sub.store_id
       WHERE sub.email = ?
       ORDER BY sub.submitted_log_at DESC`
    )
    .all(email || '');
}

// 담당자 표시 이름 조회 (감사로그 기준)
function userNameByEmail(email) {
  const row = db
    .prepare(`SELECT MAX(user_name) AS name FROM audit_log WHERE COALESCE(user_email,'') = ?`)
    .get(email || '');
  return (row && row.name) || email || '(미상)';
}

// 매장별 "마지막 담당자" 맵 { storeId: {user_name, user_email, action, created_at} }
function lastActorByStore() {
  const rows = db
    .prepare(
      `SELECT a.store_id, a.user_name, a.user_email, a.action, a.created_at
       FROM audit_log a
       JOIN (SELECT store_id, MAX(id) AS mid FROM audit_log WHERE store_id IS NOT NULL GROUP BY store_id) m
         ON a.id = m.mid`
    )
    .all();
  const map = {};
  rows.forEach((r) => {
    map[r.store_id] = r;
  });
  return map;
}

module.exports = {
  db,
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
  lastActorByStore,
  userStats,
  storesSubmittedByUser,
  userNameByEmail,
  nhnRequestedAt,
  markApproveNotified,
  submitterEmailForStore
};
