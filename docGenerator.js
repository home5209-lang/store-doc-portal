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
async function generateConsentDoc(store, opts, outPath) {
  const { signature = null } = opts || {};
  const owner = store.owner_name || '';
  const phones = store.phone_numbers || '';

  const buffer = await renderToBuffer((doc) => {
    doc.font('krb').fontSize(12).text('<전화번호 이용 승낙서 – 사업자(타사 소속 임직원 포함)>');
    doc.moveDown(0.7);

    const boxX = doc.page.margins.left;
    const boxTop = doc.y;
    const boxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pad = 18;
    const innerX = boxX + pad;
    const innerW = boxW - pad * 2;

    const para = (text, { font = 'kr', size = 11, gap = 6 } = {}) => {
      doc.font(font).fontSize(size).text(text, innerX, doc.y, { width: innerW, lineGap: 3 });
      doc.y += gap;
    };
    const blank = (h = 12) => { doc.y += h; };
    const item = (marker, text, { markerX = innerX, textX = innerX + 18, size = 11, gap = 7 } = {}) => {
      const startY = doc.y;
      doc.font('kr').fontSize(size);
      doc.text(marker, markerX, startY, { width: textX - markerX });
      doc.text(text, textX, startY, { width: innerW - (textX - innerX), lineGap: 3 });
      doc.y += gap;
    };

    doc.y = boxTop + pad;
    para('전화번호 이용 승낙서', { font: 'krb', size: 13, gap: 4 });
    blank(10);
    para('발신번호 명의자는 [*] 서비스 계정 명의자에게 발신번호 명의자의 아래와 같은 전화번호 사용을 허락함.', { gap: 6 });
    blank(8);
    item('•', `발신번호 명의자 정보: ${owner}`);
    item('•', '계정 명의자 정보: 주식회사 와드');
    item('•', '목적: 마케팅메세지 발송');
    item('•', `전화번호 목록: ${phones}`);
    item('•', '별첨: 아래와 같은 서류를 함께 제출할 것');
    const nX = innerX + 20;
    const nText = innerX + 42;
    item('1)', '통신서비스이용증명원(전화번호 목록 내 기재되어 있는 전화번호와 모두 일치할 것)', { markerX: nX, textX: nText });
    item('2)', '사업자등록증', { markerX: nX, textX: nText });
    item('3)', '발신번호 명의자와 계정 명의자 간 관계를 확인할 수 있는 문서(예. 업무위수탁 계약서. 본점 – 지점 증빙서류 등)', { markerX: nX, textX: nText });
    item('4)', '전화번호 목록에 임직원의 번호가 포함된 경우 해당 임직원의 재직증명서', { markerX: nX, textX: nText });
    blank(26);

    // 서명 줄: "발신번호 명의자 : {owner}   (인)"  — 서명은 (인) 위에 겹쳐 얹음
    const lineY = doc.y;
    doc.font('kr').fontSize(12);
    const before = `발신번호 명의자 : ${owner}   `;
    const inW = doc.widthOfString('(인)');
    const inX = innerX + doc.widthOfString(before);
    doc.text(before + '(인)', innerX, lineY, { continued: false });
    placeSignatureOver(doc, signature, inX + inW / 2, lineY + 7, 90);
    doc.y = lineY + 24;

    doc.lineWidth(1).rect(boxX, boxTop, boxW, doc.y + pad - boxTop).stroke();
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

// ---------- 2. 재직 증명서 ----------
async function generateEmploymentCert(store, opts, outPath) {
  const { signature = null, birth = '', period = '', issueDate = '' } = opts || {};

  const buffer = await renderToBuffer((doc) => {
    doc.font('krb').fontSize(22).text('재 직 증 명 서', { align: 'center' });
    doc.moveDown(0.4);
    // 제목 밑 가는 선
    const lx = doc.page.margins.left;
    const rw = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.moveTo(lx, doc.y).lineTo(lx + rw, doc.y).lineWidth(1).strokeColor('#B0824A').stroke();
    doc.strokeColor('black');
    doc.moveDown(1.2);

    // 표
    const rows = [
      ['성 명', store.owner_name || ''],
      ['생년월일', birth],
      ['직 위', store.contact_title || '대표'],
      ['재직 기간', period],
      ['소속(상호명)', store.name || ''],
      ['사업자등록번호', store.biz_reg_no || '']
    ];
    const tableX = lx;
    const labelW = 130;
    const valueW = rw - labelW;
    const rowH = 30;
    let ty = doc.y;
    rows.forEach(([label, value]) => {
      doc.rect(tableX, ty, labelW, rowH).fillAndStroke('#F3EFE7', '#333');
      doc.rect(tableX + labelW, ty, valueW, rowH).fillAndStroke('#FFFFFF', '#333');
      doc.fillColor('#000');
      doc.font('krb').fontSize(11).text(label, tableX, ty + 9, { width: labelW, align: 'center' });
      doc.font('kr').fontSize(11).text(value, tableX + labelW + 10, ty + 9, { width: valueW - 20 });
      ty += rowH;
    });
    doc.y = ty + 24;

    doc.font('kr').fontSize(12).text('위 사람은 상기 사업장에 재직하고 있음을 증명합니다.', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('krb').fontSize(12).text('용도 : NHN Cloud 발신번호 등록 심사 제출용', { align: 'center' });
    doc.moveDown(2);
    doc.font('kr').fontSize(12).text(issueDate || ' ', { align: 'center' });
    doc.moveDown(2.5);

    // 서명 줄 (우측): "대표자 : {owner}  [서명]  (인)"
    const owner = store.owner_name || '';
    const lineY = doc.y;
    const text = `상호명 : ${store.name || ''}`;
    doc.font('kr').fontSize(12).text(text, lx, lineY, { width: rw, align: 'right' });
    const line2Y = doc.y + 6;
    const label = `대표자 : ${owner}    `;
    // 오른쪽 정렬: 라벨 + (인) 을 오른쪽에 배치, 서명은 (인) 위에 겹쳐 얹음
    doc.font('kr').fontSize(12);
    const labelWidth = doc.widthOfString(label);
    const inW = doc.widthOfString('(인)');
    const inX = lx + rw - inW;
    const labelX = inX - labelWidth;
    doc.text(label + '(인)', labelX, line2Y);
    placeSignatureOver(doc, signature, inX + inW / 2, line2Y + 7, 90);
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

module.exports = { generateConsentDoc, generateEmploymentCert };
