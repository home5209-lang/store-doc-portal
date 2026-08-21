'use strict';

// 캐치테이블 내부 어드민 API로 shop_seq(매장 시퀀스넘버) → 매장명을 조회한다.
//   GET {BASE}/internal-api/v1/shops/{seq}
//   응답 예: { "id": 5, "name": "5@ 테이블노트", "state": "A", "subState": "ACTIVE", ... }
//   → 우리가 쓰는 값은 id(시퀀스)와 name(매장명/상호명)뿐. 개인 전화번호는 사용하지 않는다.
//
// 사내망 접근 기반이라 기본은 인증 키 없이 호출한다.
// 혹시 키가 필요하면 .env 에 아래를 넣으면 헤더로 자동 첨부된다.
//   CT_ADMIN_API_BASE        = https://ct-biz-manager-api.wadcorp.in   (기본값 내장)
//   CT_ADMIN_API_AUTH_HEADER = Authorization   (또는 X-API-Key 등, 헤더 이름)
//   CT_ADMIN_API_KEY         = <키 값>          (예: "Bearer xxxxx" 전체 또는 키 값)

function clean(v) {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '');
}

const BASE = (clean(process.env.CT_ADMIN_API_BASE) || 'https://ct-biz-manager-api.wadcorp.in').replace(/\/+$/, '');

function isConfigured() {
  return Boolean(BASE);
}

function authHeaders() {
  const name = clean(process.env.CT_ADMIN_API_AUTH_HEADER);
  const key = clean(process.env.CT_ADMIN_API_KEY);
  if (name && key) return { [name]: key };
  return {};
}

// shop_seq 로 매장 1건 조회. 반환: { id, name, state, subState }
async function fetchShopBySeq(seq) {
  const s = String(seq == null ? '' : seq).trim();
  if (!/^\d+$/.test(s)) throw new Error('시퀀스넘버는 숫자여야 합니다.');
  const url = `${BASE}/internal-api/v1/shops/${s}`;

  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...authHeaders() } });
  } catch (e) {
    throw new Error(`API 호출 실패(네트워크/사내망 확인): ${e.message}`);
  }

  if (!res.ok) {
    if (res.status === 404) throw new Error(`시퀀스 ${s} 매장을 찾을 수 없습니다.`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`인증 필요/거부 (HTTP ${res.status}). .env 의 CT_ADMIN_API_AUTH_HEADER / CT_ADMIN_API_KEY 설정을 확인하세요.`);
    }
    throw new Error(`매장 조회 실패 (HTTP ${res.status})`);
  }

  const json = await res.json().catch(() => null);
  if (!json || json.name == null || String(json.name).trim() === '') {
    throw new Error('응답에 매장명(name)이 없습니다.');
  }
  return { id: json.id, name: String(json.name).trim(), state: json.state, subState: json.subState };
}

// ── 매장명 검색 ──────────────────────────────────────
// 이 API는 이름 필터를 지원하지 않고 /shops 가 전체 목록을 반환하므로,
// 전체 목록을 한 번 받아 메모리에 캐시해두고 우리가 이름/시퀀스로 걸러준다.
let _cache = { at: 0, list: [] };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of ['data', 'content', 'shops', 'list', 'items', 'result', 'results']) {
      if (Array.isArray(json[k])) return json[k];
    }
  }
  return [];
}

async function loadAllShops(force = false) {
  const fresh = Date.now() - _cache.at < CACHE_TTL_MS;
  if (!force && fresh && _cache.list.length) return _cache.list;

  const url = `${BASE}/internal-api/v1/shops`;
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...authHeaders() } });
  } catch (e) {
    throw new Error(`매장 목록 호출 실패(사내망 확인): ${e.message}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`인증 필요/거부 (HTTP ${res.status}). .env 의 CT_ADMIN_API_* 설정을 확인하세요.`);
    }
    throw new Error(`매장 목록 조회 실패 (HTTP ${res.status})`);
  }
  const json = await res.json().catch(() => null);
  const list = pickArray(json)
    // 목록 응답은 { data: [ { shopId, name } ] } 형태(단건은 id). 둘 다 대응.
    .map((s) => ({ id: s.shopId != null ? s.shopId : s.id, name: s.name == null ? '' : String(s.name).trim() }))
    .filter((s) => s.id != null && s.name);
  _cache = { at: Date.now(), list };
  return list;
}

// 이름 또는 시퀀스 부분일치로 매장을 검색. 반환: [{ id, name }] (최대 limit개)
async function searchShops(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const all = await loadAllShops();
  const qLower = q.toLowerCase();
  const isNum = /^\d+$/.test(q);

  const matched = all.filter((s) => {
    const nameHit = s.name.toLowerCase().includes(qLower);
    const seqHit = isNum && String(s.id).includes(q);
    return nameHit || seqHit;
  });

  // 정렬: 시퀀스 정확일치 → 이름이 q로 시작 → 나머지
  matched.sort((a, b) => {
    const aExact = isNum && String(a.id) === q ? 0 : 1;
    const bExact = isNum && String(b.id) === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aStart = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
    const bStart = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return a.name.localeCompare(b.name);
  });

  return matched.slice(0, limit);
}

// 전체목록 응답의 실제 형식을 확인하기 위한 디버그 도우미
async function debugList() {
  const url = `${BASE}/internal-api/v1/shops`;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...authHeaders() } });
  const text = await res.text();
  let parsed = null, type = 'n/a', topKeys = [], firstItemKeys = [];
  try {
    parsed = JSON.parse(text);
    type = Array.isArray(parsed) ? 'array' : typeof parsed;
    if (Array.isArray(parsed)) {
      if (parsed[0] && typeof parsed[0] === 'object') firstItemKeys = Object.keys(parsed[0]);
    } else if (parsed && typeof parsed === 'object') {
      topKeys = Object.keys(parsed).slice(0, 20);
      for (const k of topKeys) {
        if (Array.isArray(parsed[k]) && parsed[k][0] && typeof parsed[k][0] === 'object') {
          firstItemKeys = [k + '[0]: ' + Object.keys(parsed[k][0]).join(', ')];
          break;
        }
      }
    }
  } catch (e) {
    type = 'not-json: ' + e.message;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), length: text.length, type, topKeys, firstItemKeys, sample: text.slice(0, 500) };
}

module.exports = { isConfigured, fetchShopBySeq, searchShops, loadAllShops, debugList, BASE };
