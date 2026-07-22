const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'db', 'portal.db'));

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
`);

// 기존 DB에 phone_numbers 컬럼이 없으면 추가 (신규 DB는 위 CREATE에 이미 포함)
try {
  db.exec('ALTER TABLE stores ADD COLUMN phone_numbers TEXT');
} catch (e) {
  /* 이미 존재하면 무시 */
}
// NHN 발신번호 등록 신청 상태: null(미신청) / 'requested'(신청함) / 'registered'(등록완료)
try {
  db.exec('ALTER TABLE stores ADD COLUMN nhn_status TEXT');
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
    // phone_numbers가 넘어오지 않으면(undefined) 기존 값 보존 (COALESCE)
    db.prepare(
      `UPDATE stores SET name=?, owner_name=?, biz_reg_no=?, contact_name=?, contact_title=?, phone_numbers=COALESCE(?, phone_numbers) WHERE id=?`
    ).run(store.name, store.owner_name, store.biz_reg_no, store.contact_name, store.contact_title, store.phone_numbers ?? null, store.id);
  } else {
    db.prepare(
      `INSERT INTO stores (id, name, owner_name, biz_reg_no, contact_name, contact_title, phone_numbers) VALUES (?,?,?,?,?,?,?)`
    ).run(store.id, store.name, store.owner_name, store.biz_reg_no, store.contact_name, store.contact_title, store.phone_numbers ?? null);
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

// NHN 등록 신청 상태 변경 ('requested' | 'registered' | null)
function setNhnStatus(storeId, status) {
  db.prepare(`UPDATE stores SET nhn_status=? WHERE id=?`).run(status, storeId);
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
  setNhnStatus
};
