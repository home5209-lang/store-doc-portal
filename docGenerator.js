'use strict';

// 자동 생성 서류(사용승낙서 / 재직증명서)를 PDF로 직접 생성한다.
// 외부 프로그램(LibreOffice 등) 없이 Node의 pdfkit만 사용하며, 한글/손글씨 폰트는
// 프로젝트에 포함된 TTF(assets/fonts)를 PDF에 임베드한다. → 어떤 서버에서도 그대로 동작.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'NanumGothic-Regular.ttf'),
  bold: path.join(FONT_DIR, 'NanumGothic-Bold.ttf'),
  sign: path.join(FONT_DIR, 'NanumPenScript.ttf') // 서명(손글씨)용
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// pdfkit 문서를 만들어 build(doc)로 그리고, 완성된 PDF를 Buffer로 돌려준다.
function renderToBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('kr', FONTS.regular);
    doc.registerFont('krb', FONTS.bold);
    doc.registerFont('sign', FONTS.sign);
    build(doc);
    doc.end();
  });
}

// ---------- 1. 전화번호 이용 승낙서 (회사 원본 샘플 양식 그대로 재현) ----------
// 원본 레이아웃: 제목(박스 밖) → 테두리 박스 안에 [소제목(좌) · 안내문 · • 5개 항목 ·
//   별첨 하위 1)~4) 번호 · 하단 서명]. 빈칸(명의자 정보/전화번호 목록/서명 이름)만 채움.
//   서명은 손글씨/(인) 없이 이름만 기재. 날짜 없음.
async function generateConsentDoc(store, outPath) {
  const owner = store.owner_name || ''; // 발신번호 명의자 = 대표자명(통신증명원 기준)
  const phones = store.phone_numbers || '';

  const buffer = await renderToBuffer((doc) => {
    // 제목 (박스 바깥, 왼쪽)
    doc.font('krb').fontSize(12).text('<전화번호 이용 승낙서 – 사업자(타사 소속 임직원 포함)>');
    doc.moveDown(0.7);

    // 테두리 박스 좌표
    const boxX = doc.page.margins.left;
    const boxTop = doc.y;
    const boxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pad = 18;
    const innerX = boxX + pad;
    const innerW = boxW - pad * 2;

    // 일반 문단 (현재 doc.y에서 시작, 아래 여백 gap)
    const para = (text, { font = 'kr', size = 11, gap = 6, x = innerX, width = innerW } = {}) => {
      doc.font(font).fontSize(size).text(text, x, doc.y, { width, lineGap: 3 });
      doc.y += gap;
    };
    const blank = (h = 12) => { doc.y += h; };

    // 마커(• 또는 1))가 붙는 항목: 마커는 markerX, 본문은 textX부터(줄바꿈 시 본문 정렬 유지)
    const item = (marker, text, { markerX = innerX, textX = innerX + 18, size = 11, gap = 7 } = {}) => {
      const startY = doc.y;
      doc.font('kr').fontSize(size);
      doc.text(marker, markerX, startY, { width: textX - markerX });
      doc.text(text, textX, startY, { width: innerW - (textX - innerX), lineGap: 3 });
      doc.y += gap; // 본문(둘 중 더 긴 쪽) 기준으로 doc.y가 잡혀 있음
    };

    doc.y = boxTop + pad;

    para('전화번호 이용 승낙서', { font: 'krb', size: 13, gap: 4 });
    blank(10);

    para('발신번호 명의자는 [*] 서비스 계정 명의자에게 발신번호 명의자의 아래와 같은 전화번호 사용을 허락함.', { gap: 6 });
    blank(8);

    // • 5개 항목
    item('•', `발신번호 명의자 정보: ${owner}`);
    item('•', '계정 명의자 정보: 주식회사 와드');
    item('•', '목적: 마케팅메세지 발송');
    item('•', `전화번호 목록: ${phones}`);
    item('•', '별첨: 아래와 같은 서류를 함께 제출할 것');

    // 별첨 하위: 1)~4) (한 단계 더 들여쓰기)
    const nX = innerX + 20;
    const nText = innerX + 42;
    item('1)', '통신서비스이용증명원(전화번호 목록 내 기재되어 있는 전화번호와 모두 일치할 것)', { markerX: nX, textX: nText });
    item('2)', '사업자등록증', { markerX: nX, textX: nText });
    item('3)', '발신번호 명의자와 계정 명의자 간 관계를 확인할 수 있는 문서(예. 업무위수탁 계약서. 본점 – 지점 증빙서류 등)', { markerX: nX, textX: nText });
    item('4)', '전화번호 목록에 임직원의 번호가 포함된 경우 해당 임직원의 재직증명서', { markerX: nX, textX: nText });

    blank(30); // 서명 전 여백(원본의 빈 줄 2개)

    // 하단 서명: 이름만 (손글씨/(인) 없음)
    para(`발신번호 명의자 : ${owner}`, { size: 12, gap: 4 });

    // 내용 높이에 맞춰 테두리 박스 그리기
    doc.lineWidth(1).rect(boxX, boxTop, boxW, doc.y + pad - boxTop).stroke();
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

// ---------- 2. 재직 증명서 ----------
async function generateEmploymentCert(store, outPath) {
  const buffer = await renderToBuffer((doc) => {
    doc.font('krb').fontSize(22).text('재 직 증 명 서', { align: 'center' });
    doc.moveDown(2);

    const rows = [
      ['성명', store.contact_name || ''],
      ['직위', store.contact_title || ''],
      ['소속(상호명)', store.name || ''],
      ['사업자등록번호', store.biz_reg_no || '']
    ];
    const labelX = doc.page.margins.left;
    const labelW = 130;
    rows.forEach(([label, value]) => {
      const rowY = doc.y;
      doc.font('krb').fontSize(12).text(label, labelX, rowY, { width: labelW });
      doc.font('kr').fontSize(12).text(value, labelX + labelW, rowY);
      doc.moveDown(0.6);
    });

    doc.moveDown(1.5);
    doc.font('kr').fontSize(12).text('위 사람은 상기 사업장에 재직 중임을 증명합니다.');
    doc.moveDown(0.5);
    doc.text('용도: 발신번호 등록 심사 제출용');
    doc.moveDown(3);
    doc.text(today(), { align: 'right' });
    doc.moveDown(1.2);
    doc.text(`상호명: ${store.name || ''}      대표자: ${store.owner_name || ''}`, { align: 'right' });
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

module.exports = { generateConsentDoc, generateEmploymentCert };
