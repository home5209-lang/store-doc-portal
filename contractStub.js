'use strict';

/**
 * 모두싸인 계약서 자동 첨부 모듈.
 *
 * 흐름: server.js가 매장 제출 시 fetchContractFromModusign(store, outPath)를 호출한다.
 *   1) 모두싸인에서 "서명 완료(COMPLETED)" 문서 목록을 조회하고
 *   2) 각 문서의 제목/서명자 표기를 매장명과 퍼지 매칭(정규화 + Jaccard + Levenshtein)하여
 *   3) 가장 점수가 높은 문서를 임계값 기준으로 판정(AUTO_MATCHED / NEEDS_REVIEW / NO_MATCH)한 뒤
 *   4) AUTO_MATCHED면 서명 완료 PDF를 내려받아 첨부하고, 그 외에는 안내 파일을 남긴다.
 *
 * 배경: 계약서 제목이나 서명자 표기가 실제 매장명과 완전히 일치하지 않는 경우가 많아
 * (예: 매장명 "라라와케이" ↔ 계약서 표기 "라라와케이 다이닝") 정확 일치만으로는 매칭이 불안정했다.
 * 접미사 제거 정규화 + 토큰 Jaccard 유사도 + Levenshtein 유사도를 결합한 스코어링으로 이를 보완한다.
 *
 * (참고: 장기적으로는 계약 생성 시 문서에 매장 고유 ID를 metadata로 심고 그 metadata로 조회하는 방식이
 *  훨씬 안정적입니다. 모두싸인 문서 목록 조회 API의 `metadatas` 쿼리 파라미터로 필터 가능.)
 */

const fs = require('fs');
const path = require('path');

const MODUSIGN_API_BASE = 'https://api.modusign.co.kr';

/* ============================================================
 * 1) 매장명 매칭 유틸리티
 * ============================================================ */

// 매장명 뒤에 흔히 붙는 업종/형태 접미사. 정규화 시 제거 대상.
const COMMON_SUFFIXES = [
  '다이닝',
  '레스토랑',
  '카페',
  '커피',
  '베이커리',
  '로스터리',
  '키친',
  '하우스',
  '바',
  '펍',
  '라운지',
  '스토어',
  '샵',
  '점',
  '지점',
  '본점',
  '분점',
];

const DEFAULT_OPTIONS = {
  jaccardWeight: 0.6,
  levenshteinWeight: 0.4,
  autoMatchThreshold: 0.85,
  reviewThreshold: 0.6,
  candidateThreshold: 0.5,
  containmentMinLen: 3,
  maxPages: 5,
  pageSize: 100,
  logger: console,
};

/**
 * 문자열을 매칭 비교 가능한 형태로 정규화한다.
 * - 공백/특수문자 정리
 * - 흔한 업종 접미사 제거 (문자열 끝에서부터, 반복 제거)
 * - 소문자화 (영문 대비)
 */
function normalizeStoreName(rawName) {
  if (!rawName) return '';

  let name = String(rawName)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[()（）\[\]{}'"~!@#$%^&*+=|\\/<>,.?:;_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 접미사는 붙어있는 형태("라라와케이다이닝")와 띄어쓰기 형태("라라와케이 다이닝") 모두 대응.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMMON_SUFFIXES) {
      if (name.endsWith(suffix) && name.length > suffix.length) {
        name = name.slice(0, name.length - suffix.length).trim();
        changed = true;
      } else if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, name.length - suffix.length - 1).trim();
        changed = true;
      }
    }
  }

  return name.trim();
}

/** 정규화된 문자열을 토큰(단어) 집합으로 분리한다. */
function tokenize(normalizedName) {
  if (!normalizedName) return [];
  return normalizedName.split(' ').filter(Boolean);
}

/** 두 토큰 배열 간 Jaccard 유사도 (교집합 크기 / 합집합 크기). */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionSize += 1;
  }
  const unionSize = setA.size + setB.size - intersectionSize;

  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** 표준 편집 거리(Levenshtein distance) 계산. */
function levenshteinDistance(a, b) {
  const lenA = a.length;
  const lenB = b.length;

  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  let prevRow = Array.from({ length: lenB + 1 }, (_, j) => j);
  let currRow = new Array(lenB + 1).fill(0);

  for (let i = 1; i <= lenA; i += 1) {
    currRow[0] = i;
    for (let j = 1; j <= lenB; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // 삭제
        currRow[j - 1] + 1, // 삽입
        prevRow[j - 1] + cost // 치환
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[lenB];
}

/** Levenshtein distance를 0~1 유사도 점수로 정규화 (1 = 완전 일치). */
function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * 두 문자열(원문) 간 종합 매칭 점수를 계산한다.
 * 정규화 → 토큰화 → Jaccard/Levenshtein 각각 계산 → 가중합.
 */
function computeMatchScore(nameA, nameB, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { jaccardWeight, levenshteinWeight, containmentMinLen } = opts;

  const normalizedA = normalizeStoreName(nameA);
  const normalizedB = normalizeStoreName(nameB);

  const jaccard = jaccardSimilarity(tokenize(normalizedA), tokenize(normalizedB));
  const levenshtein = levenshteinSimilarity(normalizedA, normalizedB);
  const weighted = jaccardWeight * jaccard + levenshteinWeight * levenshtein;

  // 포함(containment) 보정: 한쪽 이름이 다른 쪽 안에 통째로 들어있으면 강하게 매칭한다.
  // 실제 계약서에는 "캐치테이블 - ", "광고", "계약변경합의서(감사제)" 같은 플랫폼/양식 노이즈가
  // 붙는 경우가 많아(예: 매장 "푸시풋살룬" ↔ 서명자 "캐치테이블 - 푸시풋살룬"),
  // 순수 토큰/편집거리만으로는 점수가 낮게 나온다. 짧은 쪽이 긴 쪽에 통째로 포함되면 가점.
  const compactA = normalizedA.replace(/\s+/g, '');
  const compactB = normalizedB.replace(/\s+/g, '');
  const shorter = compactA.length <= compactB.length ? compactA : compactB;
  const longer = compactA.length <= compactB.length ? compactB : compactA;
  let containment = 0;
  if (shorter.length >= containmentMinLen && longer.includes(shorter)) {
    containment = 0.9 + 0.1 * (shorter.length / longer.length);
  }

  const combined = Math.max(weighted, containment);

  return { normalizedA, normalizedB, jaccard, levenshtein, containment, combined };
}

/**
 * 하나의 query(매장명)를 후보 문자열 목록과 비교하여 최고 점수와 판정을 돌려준다.
 * (문서 매칭에서도 재사용: 문서의 제목/서명자들을 후보로 넘긴다.)
 */
function matchStoreName(query, candidates, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = opts.logger || DEFAULT_OPTIONS.logger;

  const scores = (candidates || [])
    .map((candidate) => {
      const { jaccard, levenshtein, combined } = computeMatchScore(query, candidate, opts);
      return { candidate, jaccard, levenshtein, combined };
    })
    .sort((a, b) => b.combined - a.combined);

  const best = scores[0] || null;

  let status = 'NO_MATCH';
  if (best) {
    if (best.combined >= opts.autoMatchThreshold) {
      status = 'AUTO_MATCHED';
    } else if (best.combined >= opts.reviewThreshold) {
      status = 'NEEDS_REVIEW';
    }
  }

  if (status === 'NEEDS_REVIEW' && logger && logger.warn) {
    logger.warn(
      `[contractStub] 매칭 애매함 (수동 확인 필요): query="${query}" ` +
        `best="${best.candidate}" combined=${best.combined.toFixed(3)} ` +
        `(jaccard=${best.jaccard.toFixed(3)}, levenshtein=${best.levenshtein.toFixed(3)})`
    );
  }

  return { query, status, bestMatch: best, scores };
}

/* ============================================================
 * 2) 모두싸인 API 연동
 * ============================================================ */

/** 환경변수에서 모두싸인 인증 정보를 읽는다. (MODUSIGN_API_KEY / API_KEY 둘 다 허용) */
function getModusignCredentials() {
  const email = process.env.MODUSIGN_EMAIL;
  const apiKey = process.env.MODUSIGN_API_KEY || process.env.API_KEY;
  return { email, apiKey };
}

function authHeader() {
  const { email, apiKey } = getModusignCredentials();
  if (!email || !apiKey) {
    throw new Error(
      'MODUSIGN_EMAIL, MODUSIGN_API_KEY(또는 API_KEY) 환경변수가 설정되어 있지 않습니다.'
    );
  }
  const encoded = Buffer.from(`${email}:${apiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

async function modusignGet(pathAndQuery) {
  const res = await fetch(`${MODUSIGN_API_BASE}${pathAndQuery}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`모두싸인 API 오류 (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/* --- 응답 형태에 관계없이 안전하게 값을 뽑아내는 헬퍼들 --- */
function extractDocumentArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  return data.documents || data.data || data.items || data.results || [];
}

function getDocId(doc) {
  return doc.id || doc.documentId || doc._id || null;
}

function getDocTitle(doc) {
  return doc.title || doc.name || doc.documentName || '';
}

function getParticipantNames(doc) {
  const participants = doc.participants || doc.signers || doc.parties || [];
  if (!Array.isArray(participants)) return [];
  return participants
    .map((p) => (p && (p.name || p.signerName || p.participantName)) || '')
    .filter(Boolean);
}

/** 완료 문서 목록을 페이지네이션으로 모아온다. */
async function listCompletedDocuments(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const filter = encodeURIComponent("status eq 'COMPLETED'");
  const all = [];

  for (let page = 0; page < opts.maxPages; page += 1) {
    const offset = page * opts.pageSize;
    const data = await modusignGet(
      `/documents?offset=${offset}&limit=${opts.pageSize}&filter=${filter}`
    );
    const documents = extractDocumentArray(data);
    if (documents.length === 0) break;
    all.push(...documents);
    if (documents.length < opts.pageSize) break; // 마지막 페이지
  }

  return all;
}

/** 한 문서에 대해 매장명과의 최고 점수를 (제목 + 서명자 모두 비교) 계산한다. */
function scoreDocumentAgainstStore(storeName, doc, options) {
  const title = getDocTitle(doc);
  const participantNames = getParticipantNames(doc);

  const candidates = [];
  if (title) candidates.push({ field: 'title', value: title });
  for (const name of participantNames) candidates.push({ field: 'participant', value: name });

  let best = { score: 0, field: null, value: null };
  for (const cand of candidates) {
    const { combined } = computeMatchScore(storeName, cand.value, options);
    if (combined > best.score) {
      best = { score: combined, field: cand.field, value: cand.value };
    }
  }
  return best;
}

/**
 * 매장명으로 가장 잘 맞는 서명 완료 계약서를 찾는다. (이름/제목 퍼지 매칭)
 * @returns {{ storeName, status, bestMatch, ranked }}
 */
async function findBestContractMatch(storeName, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = opts.logger || DEFAULT_OPTIONS.logger;

  const documents = await listCompletedDocuments(opts);

  const ranked = documents
    .map((doc) => {
      const best = scoreDocumentAgainstStore(storeName, doc, opts);
      return {
        documentId: getDocId(doc),
        title: getDocTitle(doc),
        matchedValue: best.value,
        matchedField: best.field,
        score: best.score,
      };
    })
    .filter((r) => r.documentId)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;

  let status = 'NO_MATCH';
  if (best) {
    if (best.score >= opts.autoMatchThreshold) status = 'AUTO_MATCHED';
    else if (best.score >= opts.reviewThreshold) status = 'NEEDS_REVIEW';
  }

  if (status === 'NEEDS_REVIEW' && logger && logger.warn) {
    logger.warn(
      `[contractStub] 계약서 매칭 애매함 (수동 확인 필요): store="${storeName}" ` +
        `best="${best.matchedValue}"(${best.matchedField}) score=${best.score.toFixed(3)} ` +
        `docId=${best.documentId}`
    );
  } else if (status === 'NO_MATCH' && logger && logger.warn) {
    logger.warn(
      `[contractStub] 계약서 매칭 실패: store="${storeName}"` +
        (best ? ` closest="${best.matchedValue}" score=${best.score.toFixed(3)}` : ' (완료 문서 없음)')
    );
  }

  return { storeName, status, bestMatch: best, ranked: ranked.slice(0, 5) };
}

/**
 * 모두싸인 서버에서 "제목에 검색어가 포함된" 서명 완료 문서를 직접 조회한다.
 * (계정 문서가 많을 때 로컬 스캔은 앞쪽 일부만 훑어 누락되므로, 모두싸인의
 *  contains(title, ...) 필터로 서버가 전체에서 찾게 한다 — UI 제목 검색과 동일.)
 */
// filter 식으로 완료문서를 페이지 순회 조회한다.
async function searchCompletedByFilter(filterExpr, opts) {
  const filter = encodeURIComponent(filterExpr);
  const all = [];
  for (let page = 0; page < opts.maxPages; page += 1) {
    const offset = page * opts.pageSize;
    // eslint-disable-next-line no-await-in-loop
    const data = await modusignGet(
      `/documents?offset=${offset}&limit=${opts.pageSize}&filter=${filter}`
    );
    const documents = extractDocumentArray(data);
    if (documents.length === 0) break;
    all.push(...documents);
    if (documents.length < opts.pageSize) break;
  }
  return all;
}

async function searchCompletedDocumentsByTitle(titleQuery, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const q = String(titleQuery || '').replace(/'/g, '').trim();
  if (!q) return [];
  return searchCompletedByFilter(`status eq 'COMPLETED' and contains(title, '${q}')`, opts);
}

// 서명자(참가자) 이름으로 완료문서를 조회한다. (캐치테이블 계약서는 매장명이 제목이 아니라
// 서명자에 있는 경우가 많아, 제목 검색만으로는 못 찾는다.)
// 모두싸인 필터 문법이 계정/버전에 따라 다를 수 있어 몇 가지를 순서대로 시도한다.
async function searchCompletedDocumentsByParticipant(nameQuery, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const q = String(nameQuery || '').replace(/'/g, '').trim();
  if (!q) return [];
  const templates = [
    `status eq 'COMPLETED' and contains(participantName, '${q}')`,
    `status eq 'COMPLETED' and participants/any(p: contains(p/name, '${q}'))`,
    `status eq 'COMPLETED' and contains(participants/name, '${q}')`
  ];
  for (const t of templates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await searchCompletedByFilter(t, opts);
      if (rows.length) return rows; // 이 필터 문법이 유효
    } catch (e) {
      /* 이 문법 미지원(4xx) → 다음 후보 시도 */
    }
  }
  return [];
}

/** 검색용 토큰: 정규화 → 공백 분리 → 공백제거 → 빈값 제거 */
function searchTokens(name) {
  return normalizeStoreName(name)
    .split(' ')
    .map((t) => t.replace(/\s+/g, ''))
    .filter(Boolean);
}

/** 문서의 "검색 대상 텍스트"(제목 + 서명자)를 정규화·공백제거해 하나로 만든다. */
function docHaystack(doc) {
  const raw = `${getDocTitle(doc)} ${getParticipantNames(doc).join(' ')}`;
  return normalizeStoreName(raw).replace(/\s+/g, '');
}

/** 완료 문서를 최근순으로 병렬 조회한다. (전체가 수만 건일 수 있어 상한 페이지까지만) */
async function scanRecentCompleted(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pageSize = opts.pageSize || 100;
  const maxPages = opts.candidateScanPages || 20;
  const filter = encodeURIComponent("status eq 'COMPLETED'");

  const first = await modusignGet(`/documents?offset=0&limit=${pageSize}&filter=${filter}`);
  const all = extractDocumentArray(first);
  const count = Number(first && first.count) || all.length;
  const pages = Math.min(Math.ceil(count / pageSize), maxPages);

  const offsets = [];
  for (let i = 1; i < pages; i += 1) offsets.push(i * pageSize);
  const settled = await Promise.allSettled(
    offsets.map((off) => modusignGet(`/documents?offset=${off}&limit=${pageSize}&filter=${filter}`))
  );
  settled.forEach((s) => {
    if (s.status === 'fulfilled') all.push(...extractDocumentArray(s.value));
  });
  return all;
}

// 완료 문서 "전체"를 받아 캐시한다. (서버가 서명자 검색을 지원하지 않아 로컬 매칭용)
//  - 전 기간 대상(2022년 문서도 포함), 각 문서에 participants(서명자)가 들어 있음
//  - 첫 호출은 전체를 받느라 느릴 수 있고, 이후 TTL 동안 캐시 재사용
let _allDocsCache = { at: 0, docs: [] };
const ALL_DOCS_TTL_MS = 30 * 60 * 1000; // 30분

function isContractCacheWarm() {
  return _allDocsCache.docs.length > 0 && Date.now() - _allDocsCache.at < ALL_DOCS_TTL_MS;
}

// 전체 목록 캐시를 백그라운드로 채운다(중복 실행 방지). 서버 시작 시·주기적으로 호출.
let _warming = null;
function warmContractCache(options = {}) {
  if (_warming) return _warming;
  _warming = loadAllCompletedDocs(options, true)
    .catch(() => {})
    .finally(() => { _warming = null; });
  return _warming;
}

async function loadAllCompletedDocs(options = {}, force = false) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!force && Date.now() - _allDocsCache.at < ALL_DOCS_TTL_MS && _allDocsCache.docs.length) {
    return _allDocsCache.docs;
  }
  const filter = encodeURIComponent("status eq 'COMPLETED'");
  // 페이지당 최대한 많이 받아 요청 횟수를 줄인다. API가 더 작은 값으로 제한하면
  // 실제 반환 개수(effSize)로 오프셋을 스텝핑해 누락을 막는다.
  const wantLimit = opts.fullLoadLimit || 1000;

  const first = await modusignGet(`/documents?offset=0&limit=${wantLimit}&filter=${filter}`);
  let all = extractDocumentArray(first);
  const count = Number(first && first.count) || all.length;
  const effSize = all.length || opts.pageSize || 100; // 실제 페이지 크기
  const totalPages = Math.ceil(count / effSize);
  const cap = opts.fullLoadMaxPages || 500; // 안전 상한
  const pages = Math.min(totalPages, cap);

  const offsets = [];
  for (let i = 1; i < pages; i += 1) offsets.push(i * effSize);

  // 배치로 동시 조회 (요청 횟수·시간 단축)
  const batchSize = opts.fullLoadConcurrency || 12;
  for (let i = 0; i < offsets.length; i += batchSize) {
    const batch = offsets.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.allSettled(
      batch.map((off) => modusignGet(`/documents?offset=${off}&limit=${effSize}&filter=${filter}`))
    );
    settled.forEach((s) => {
      if (s.status === 'fulfilled') all = all.concat(extractDocumentArray(s.value));
    });
  }

  _allDocsCache = { at: Date.now(), docs: all };
  return all;
}

/**
 * 매장명(검색어)에 매칭되는 서명 완료 계약서 "후보"를 돌려준다.
 * 모두싸인 UI처럼 제목뿐 아니라 "서명자"까지 검색 대상에 포함한다.
 *   (1) 서버 제목 검색: 제목에 매장명이 들어간 문서(전체 대상, 빠름)
 *   (2) 최근 완료문서 병렬 스캔: 서명자에 매장명이 들어간 문서(제목은 일반명인 경우)
 * 두 결과를 합쳐, "검색 토큰이 (제목+서명자)에 모두 포함"되는 문서만 후보로 남긴다.
 * @returns {Array<{ documentId, title, signers, createdAt, matchedField, matchedValue, score }>}
 */
async function findContractCandidates(storeName, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tokens = searchTokens(storeName);
  const byId = new Map();

  const consider = (doc) => {
    const id = getDocId(doc);
    if (!id) return;
    const hay = docHaystack(doc);
    // 모두싸인 UI와 동일하게: 검색 토큰이 제목+서명자 어딘가에 "모두" 들어있어야 후보
    if (!tokens.length || !tokens.every((t) => hay.includes(t))) return;
    const best = scoreDocumentAgainstStore(storeName, doc, opts);
    const cand = {
      documentId: id,
      title: getDocTitle(doc),
      signers: getParticipantNames(doc),
      createdAt: doc.createdAt || doc.created_at || null,
      matchedField: best.field || 'title',
      matchedValue: best.value,
      score: best.score,
    };
    const prev = byId.get(id);
    if (!prev || cand.score > prev.score) byId.set(id, cand);
  };

  // 모두싸인 오픈 API는 "서명자(참가자)"로 서버 검색이 안 되고 제목만 필터된다.
  const longest = tokens.slice().sort((a, b) => b.length - a.length)[0] || storeName;
  const errors = [];
  let anyOk = false;

  // (1) 빠른 경로 — 서버 제목 검색 (대부분 매장은 이름이 제목에 있음)
  try {
    (await searchCompletedDocumentsByTitle(longest, opts)).forEach(consider);
    anyOk = true;
  } catch (e) {
    errors.push(e.message || String(e));
  }

  // (2) 서명자 매칭 — 전체 캐시로 로컬 스캔(전 기간·서명자 포함).
  //     캐시가 아직 준비 전이면 이번 검색은 준비될 때까지 기다렸다가 정확히 답한다(최초 1회).
  try {
    if (!isContractCacheWarm()) await warmContractCache(opts);
    if (isContractCacheWarm()) {
      _allDocsCache.docs.forEach(consider);
      anyOk = true;
    }
  } catch (e) {
    errors.push(e.message || String(e));
  }

  // 모든 조회가 실패(그리고 후보 0건)면 "못 찾음"이 아니라 실제 오류로 알린다.
  if (!anyOk && byId.size === 0 && errors.length) {
    throw new Error(errors[0]);
  }

  return [...byId.values()].sort(
    (a, b) =>
      b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
}

/** 서명 완료 문서의 PDF를 내려받아 outPath에 저장한다. */
async function downloadSignedPdf(documentId, outPath) {
  const detail = await modusignGet(`/documents/${documentId}`);
  const downloadUrl =
    (detail && detail.file && detail.file.downloadUrl) ||
    (detail && detail.downloadUrl) ||
    null;
  if (!downloadUrl) {
    throw new Error('완료 문서에서 downloadUrl을 찾지 못했습니다. (문서가 아직 완료 상태가 아닐 수 있습니다)');
  }

  // downloadUrl은 발급 후 짧은 시간(약 10분)만 유효하므로 즉시 받아야 한다.
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`계약서 파일 다운로드 실패 (${fileRes.status})`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
  return outPath;
}

/** 매칭 실패/보류 시 운영자용 안내 텍스트 파일을 남긴다. */
function writeNotice(outPath, storeName, result) {
  const txtPath = outPath.replace(/\.pdf$/i, '.txt');
  const b = result && result.bestMatch;
  let body;
  if (result && result.status === 'NEEDS_REVIEW' && b) {
    body =
      `[자동 매칭 보류 — 수동 확인 필요]\n\n` +
      `"${storeName}" 와(과) 비슷하지만 확신하기 어려운 계약서를 찾았습니다.\n` +
      `가장 유력한 후보: "${b.matchedValue}" (${b.matchedField}), 점수 ${b.score.toFixed(3)}\n` +
      `문서 ID: ${b.documentId}\n\n` +
      `운영자가 모두싸인에서 위 문서가 맞는지 확인 후 수동으로 첨부해주세요.\n`;
  } else {
    body =
      `[자동 매칭 실패]\n\n` +
      `"${storeName}" 이름과 충분히 일치하는 서명 완료 계약서를 모두싸인에서 찾지 못했습니다.\n` +
      (b
        ? `가장 가까운 후보: "${b.matchedValue}" (${b.matchedField}), 점수 ${b.score.toFixed(3)} — 임계값 미달\n`
        : `완료된 문서가 없거나 조회 결과가 비어 있습니다.\n`) +
      `\n운영자가 모두싸인에서 직접 확인 후 수동으로 첨부해주세요.\n`;
  }
  fs.mkdirSync(path.dirname(txtPath), { recursive: true });
  fs.writeFileSync(txtPath, body, 'utf-8');
  return txtPath;
}

function writeErrorNotice(outPath, err) {
  const txtPath = outPath.replace(/\.pdf$/i, '.txt');
  const body =
    `[모두싸인 연동 오류]\n\n${err.message}\n\n` +
    `운영자가 모두싸인에서 직접 확인 후 수동으로 첨부해주세요.\n`;
  fs.mkdirSync(path.dirname(txtPath), { recursive: true });
  fs.writeFileSync(txtPath, body, 'utf-8');
  return txtPath;
}

/**
 * server.js 진입점. 매칭 실패/오류 시에도 서류 제출 흐름 자체는 막지 않고
 * 안내 텍스트를 남겨 운영자가 수동으로 확인/재시도할 수 있게 한다.
 *
 * @param {{name?: string, storeName?: string}} store
 * @param {string} outPath 계약서 저장 경로 (예: .../캐치테이블_이용계약서.pdf)
 * @returns {{ matched: boolean, status: string, ... }}
 */
async function fetchContractFromModusign(store, outPath, options = {}) {
  const storeName =
    (store && (store.name || store.storeName)) || (typeof store === 'string' ? store : '');

  try {
    const result = await findBestContractMatch(storeName, options);

    if (result.status === 'AUTO_MATCHED' && result.bestMatch) {
      const pdfPath = outPath.replace(/\.txt$/i, '.pdf');
      await downloadSignedPdf(result.bestMatch.documentId, pdfPath);
      return {
        matched: true,
        status: result.status,
        documentId: result.bestMatch.documentId,
        score: result.bestMatch.score,
        matchedOn: result.bestMatch.matchedField,
        matchedValue: result.bestMatch.matchedValue,
        path: pdfPath,
      };
    }

    writeNotice(outPath, storeName, result);
    return {
      matched: false,
      status: result.status,
      bestMatch: result.bestMatch,
    };
  } catch (err) {
    writeErrorNotice(outPath, err);
    return { matched: false, status: 'ERROR', error: err.message };
  }
}

/**
 * (하위 호환) 매장명으로 완료 문서 ID를 찾는다. AUTO_MATCHED일 때만 문서 ID를 돌려주고,
 * 그 외에는 null을 반환한다.
 */
async function findCompletedDocumentByStoreName(storeName, options = {}) {
  const result = await findBestContractMatch(storeName, options);
  return result.status === 'AUTO_MATCHED' && result.bestMatch
    ? result.bestMatch.documentId
    : null;
}

module.exports = {
  // 진입점 (server.js에서 사용)
  fetchContractFromModusign,
  // 모두싸인 연동
  findBestContractMatch,
  findContractCandidates,
  warmContractCache,
  isContractCacheWarm,
  searchCompletedDocumentsByTitle,
  findCompletedDocumentByStoreName,
  downloadSignedPdf,
  listCompletedDocuments,
  getModusignCredentials,
  // 매칭 유틸
  COMMON_SUFFIXES,
  DEFAULT_OPTIONS,
  normalizeStoreName,
  tokenize,
  jaccardSimilarity,
  levenshteinDistance,
  levenshteinSimilarity,
  computeMatchScore,
  matchStoreName,
  scoreDocumentAgainstStore,
};
