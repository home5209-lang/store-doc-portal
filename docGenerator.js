'use strict';

// 매장이 브라우저에서 작성 + 손서명한 값으로 사용승낙서 / 재직증명서 PDF를 생성한다.
// 외부 프로그램 없이 pdfkit + 프로젝트 내장 한글 폰트만 사용.
// 서명은 캔버스에서 그린 PNG(Buffer)를 명의자/대표자 (인) 자리에 얹는다.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'NanumGothic-Regular.ttf'),
  bold: path.join(FONT_DIR, 'NanumGothic-Bold.ttf')
};

// 원본 승낙서 양식(전화번호이용승낙서_template.docx)을 그대로 렌더한 배경 이미지.
// 이 위에 값만 얹어서 원본과 100% 동일한 레이아웃을 보장한다.
const CONSENT_BG = path.join(__dirname, 'assets', 'consent_bg.png');
const A4_W = 595.304;
const A4_H = 841.89;

function renderToBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('kr', FONTS.regular);
    doc.registerFont('krb', FONTS.bold);
    build(doc);
    doc.end();
  });
}

// 서명 이미지(있으면)를 지정 위치에 얹는다. sig = Buffer(PNG) | null
function placeSignature(doc, sig, x, y, h = 30) {
  if (!sig) return;
  try {
    doc.image(sig, x, y, { height: h });
  } catch (e) {
    /* 서명 이미지 오류는 무시 (서명 없이 진행) */
  }
}

// 서명을 (인) 글자 위에 겹쳐 얹는다. (centerX, centerY = (인)의 중심점)
function placeSignatureOver(doc, sig, centerX, centerY, w = 90) {
  if (!sig) return;
  const h = w / 3.4; // 서명 캔버스 비율(380x112)에 맞춘 대략 높이
  try {
    doc.image(sig, centerX - w / 2, centerY - h / 2, { width: w });
  } catch (e) {
    /* 서명 이미지 오류는 무시 */
  }
}

// ---------- 1. 전화번호 이용 승낙서 ----------
// 원본 양식(docx)을 그대로 렌더한 배경 이미지 위에 값만 얹어, 레이아웃을 100% 동일하게 유지한다.
// 좌표는 원본 PDF의 단어 bbox(pt, A4 595.3x841.9)에서 측정한 값.
async function generateConsentDoc(store, opts, outPath) {
  const { signature = null } = opts || {};
  const owner = store.owner_name || '';
  const phones = store.phone_numbers || '';

  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('kr', FONTS.regular);
    doc.registerFont('krb', FONTS.bold);

    // 배경: 원본 승낙서 양식
    doc.image(CONSENT_BG, 0, 0, { width: A4_W, height: A4_H });

    // 값 얹기 (라벨 오른쪽 빈칸)
    doc.fillColor('#000').font('kr').fontSize(11);
    doc.text(owner, 197, 224, { lineBreak: false });     // 발신번호 명의자 정보:
    doc.text(phones, 164, 307, { lineBreak: false });    // 전화번호 목록:
    doc.text(owner, 155, 535, { lineBreak: false });     // 서명줄: 발신번호 명의자 :  ___

    // 서명: "(인)" 위에 겹쳐 얹음 (넓힌 양식 기준 (인) x≈273)
    placeSignatureOver(doc, signature, 273, 543, 82);

    doc.end();
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

// ---------- 2. 재직 증명서 ----------
// 격자 표가 아니라 "증명서" 문서 형태: 외곽 테두리 + 큰 제목 + 밑줄식 인적사항 + 서술형 본문 + 하단 서명부.
async function generateEmploymentCert(store, opts, outPath) {
  const { signature = null, birth = '', period = '', issueDate = '' } = opts || {};

  const buffer = await renderToBuffer((doc) => {
    const pageW = doc.page.width;
    const pageH = doc.page.height;

    // 외곽 이중 테두리 (증명서 느낌)
    doc.lineWidth(2).strokeColor('#2B2B2B').rect(38, 40, pageW - 76, pageH - 80).stroke();
    doc.lineWidth(0.7).strokeColor('#9A9A9A').rect(46, 48, pageW - 92, pageH - 96).stroke();
    doc.strokeColor('black');

    const left = 92;
    const right = pageW - 92;
    const innerW = right - left;

    // 제목
    doc.fillColor('#1B1B1B').font('krb').fontSize(30)
      .text('재 직 증 명 서', left, 112, { width: innerW, align: 'center', characterSpacing: 4 });
    // 제목 밑 금색 룰
    doc.moveTo(left + 120, 172).lineTo(right - 120, 172).lineWidth(1.4).strokeColor('#B0824A').stroke();
    doc.strokeColor('black').fillColor('#000');

    // 인적사항 — 라벨 : 값 (밑줄식, 격자 없음)
    const rows = [
      ['성       명', store.owner_name || ''],
      ['생 년 월 일', birth],
      ['직       위', store.contact_title || '대표'],
      ['재 직 기 간', period],
      ['소속(상호명)', store.name || ''],
      ['사업자등록번호', store.biz_reg_no || '']
    ];
    const labelX = left + 24;
    const labelW = 150;
    const valX = left + 190;
    const valRight = right - 24;
    let y = 224;
    rows.forEach(([label, val]) => {
      doc.font('krb').fontSize(12.5).fillColor('#3A3A3A').text(label, labelX, y, { width: labelW });
      doc.font('krb').fontSize(12.5).fillColor('#3A3A3A').text(':', valX - 16, y);
      doc.font('kr').fontSize(12.5).fillColor('#111').text(val || '', valX, y, { width: valRight - valX });
      doc.moveTo(valX, y + 21).lineTo(valRight, y + 21).lineWidth(0.6).strokeColor('#CFC7BB').stroke();
      y += 42;
    });
    doc.strokeColor('black').fillColor('#000');

    // 서술형 본문
    y += 26;
    doc.font('kr').fontSize(13).fillColor('#111')
      .text('위 사람은 위와 같이 본 사업장에 재직하고 있음을 증명합니다.', left, y, { width: innerW, align: 'center' });
    y += 32;
    doc.font('krb').fontSize(12.5)
      .text('용도 : NHN Cloud 발신번호 등록 심사 제출용', left, y, { width: innerW, align: 'center' });

    // 발급일
    y += 52;
    doc.font('kr').fontSize(13).text(issueDate || ' ', left, y, { width: innerW, align: 'center' });

    // 하단 서명부 (우측 정렬)
    const sy = y + 64;
    doc.font('kr').fontSize(13).fillColor('#111')
      .text(`상호명 : ${store.name || ''}`, left, sy, { width: innerW, align: 'right' });

    const line2Y = doc.y + 10;
    const owner = store.owner_name || '';
    doc.font('kr').fontSize(13);
    const inW = doc.widthOfString('(인)');
    const inX = right - inW;
    const full = `대표자 : ${owner}          (인)`;
    doc.text(full, left, line2Y, { width: innerW, align: 'right' });
    // 서명을 (인) 위에 겹쳐 얹음
    placeSignatureOver(doc, signature, inX + inW / 2, line2Y + 8, 86);
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

module.exports = { generateConsentDoc, generateEmploymentCert };
