'use strict';

// 영업일(주말·공휴일 제외) 계산 유틸.
//   NHN은 주말/공휴일에 발신번호 심사를 하지 않으므로, "미승인 → 자동 거부" 판정 시
//   벽시계 시간이 아니라 "영업일이 며칠 지났는지"로 따져야 한다.
//
// 공휴일 관리:
//   · 아래 KR_HOLIDAYS_2026 은 2026년 대한민국 법정공휴일(대체공휴일 포함, 요일 검증 완료).
//   · 매년 갱신이 필요하다. 코드 수정 없이 .env 로 추가/보완하려면:
//       NHN_HOLIDAYS=2027-01-01,2027-02-16,2027-02-17,...   (YYYY-MM-DD 쉼표구분)
//   · env 값은 기본 목록에 "합쳐진다"(덮어쓰지 않음).

const KR_HOLIDAYS_2026 = [
  '2026-01-01', // 신정
  '2026-02-16', // 설날 연휴
  '2026-02-17', // 설날
  '2026-02-18', // 설날 연휴
  '2026-03-01', // 삼일절(일)
  '2026-03-02', // 삼일절 대체공휴일
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날(일)
  '2026-05-25', // 부처님오신날 대체공휴일
  '2026-06-06', // 현충일(토, 대체 없음)
  '2026-08-15', // 광복절(토)
  '2026-08-17', // 광복절 대체공휴일
  '2026-09-24', // 추석 연휴
  '2026-09-25', // 추석
  '2026-09-26', // 추석 연휴(토)
  '2026-09-28', // 추석 대체공휴일
  '2026-10-03', // 개천절(토)
  '2026-10-05', // 개천절 대체공휴일
  '2026-10-09', // 한글날
  '2026-12-25' // 성탄절
];

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 기본 공휴일 + .env(NHN_HOLIDAYS) 를 합친 Set 을 반환.
function holidaySet() {
  const extra = String(process.env.NHN_HOLIDAYS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  return new Set([...KR_HOLIDAYS_2026, ...extra]);
}

function isBusinessDay(d, holidays = holidaySet()) {
  const dow = d.getDay(); // 0=일, 6=토
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ymd(d));
}

// from(제출시각) '다음 날'부터 to(현재)까지, 영업일이 며칠 지났는지 센다.
//  · from/to 는 Date. 시각은 무시하고 "날짜" 기준으로 계산.
//  · 예) 목요일 제출, 금요일 현재 → 1 (토·일 제외). 다음 월요일 현재 → 2.
function businessDaysElapsed(from, to, holidays = holidaySet()) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1); // 제출 당일은 제외, 다음 날부터
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (isBusinessDay(cur, holidays)) count += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

module.exports = { businessDaysElapsed, isBusinessDay, holidaySet, ymd, KR_HOLIDAYS_2026 };
