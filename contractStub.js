'use strict';

/**
 * 모두싸인 계약서 제목/서명자 문자열에서 매장명을 추출·매칭하기 위한 유틸리티.
 *
 * 배경: 계약서 제목이나 서명자 표기가 실제 매장명과 완전히 일치하지 않는 경우가 많다.
 * 예) 매장명 "라라와케이" ↔ 계약서 표기 "라라와케이 다이닝"
 * 정확 일치(exact match)만으로는 이런 표기 차이를 잡아내지 못하므로,
 * 접미사 제거 정규화 + 토큰 Jaccard 유사도 + Levenshtein 유사도를 결합한
 * 스코어링 방식으로 매칭한다.
 */

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

  let name = rawName
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
 * 두 매장명(원문) 간 종합 매칭 점수를 계산한다.
 * 정규화 → 토큰화 → Jaccard/Levenshtein 각각 계산 → 가중합.
 */
function computeMatchScore(nameA, nameB, options = {}) {
  const { jaccardWeight, levenshteinWeight } = { ...DEFAULT_OPTIONS, ...options };

  const normalizedA = normalizeStoreName(nameA);
  const normalizedB = normalizeStoreName(nameB);

  const jaccard = jaccardSimilarity(tokenize(normalizedA), tokenize(normalizedB));
  const levenshtein = levenshteinSimilarity(normalizedA, normalizedB);
  const combined = jaccardWeight * jaccard + levenshteinWeight * levenshtein;

  return { normalizedA, normalizedB, jaccard, levenshtein, combined };
}

/**
 * 계약서 제목/서명자 문자열(query)을 후보 매장명 목록과 비교하여 가장 유력한 매장을 찾는다.
 *
 * @param {string} query 계약서 제목 또는 서명자 표기 문자열
 * @param {string[]} storeCandidates 매칭 대상 매장명 목록
 * @param {object} [options]
 * @returns {{
 *   query: string,
 *   status: 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'NO_MATCH',
 *   bestMatch: { storeName: string, jaccard: number, levenshtein: number, combined: number } | null,
 *   scores: Array<{ storeName: string, jaccard: number, levenshtein: number, combined: number }>
 * }}
 */
function matchStoreName(query, storeCandidates, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = opts.logger || DEFAULT_OPTIONS.logger;

  const scores = (storeCandidates || [])
    .map((storeName) => {
      const { jaccard, levenshtein, combined } = computeMatchScore(query, storeName, opts);
      return { storeName, jaccard, levenshtein, combined };
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

  if (status === 'NEEDS_REVIEW') {
    logger.warn(
      `[contractStub] 매장명 매칭 애매함 (수동 확인 필요): query="${query}" ` +
        `bestMatch="${best.storeName}" combined=${best.combined.toFixed(3)} ` +
        `(jaccard=${best.jaccard.toFixed(3)}, levenshtein=${best.levenshtein.toFixed(3)})`
    );
  } else if (status === 'NO_MATCH') {
    logger.warn(
      `[contractStub] 매장명 매칭 실패: query="${query}"` +
        (best
          ? ` closest="${best.storeName}" combined=${best.combined.toFixed(3)}`
          : ' (후보 없음)')
    );
  }

  return { query, status, bestMatch: best, scores };
}

module.exports = {
  COMMON_SUFFIXES,
  DEFAULT_OPTIONS,
  normalizeStoreName,
  tokenize,
  jaccardSimilarity,
  levenshteinDistance,
  levenshteinSimilarity,
  computeMatchScore,
  matchStoreName,
};
