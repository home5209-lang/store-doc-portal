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

// ---------- 1. 전화번호 이용 승낙서 (회사 원본 샘플 양식 재현) ----------
// 빈칸만 매장 정보로 채움: 명의자 정보(대표자명) / 전화번호 목록 / 서명(대표자명 + 마지막 글자 손글씨)
async function generateConsentDoc(store, outPath) {
  const owner = store.owner_name || ''; // 발신번호 명의자 = 대표자명(통신증명원 기준)
  const phones = store.phone_numbers || '';

  const buffer = await renderToBuffer((doc) => {
    // 제목 (박스 바깥)
    doc.font('krb').fontSize(12).text('<전화번호 이용 승낙서 – 사업자(타사 소속 임직원 포함)>');
    doc.moveDown(0.6);

    // 테두리 박스 좌표
    const boxX = doc.page.margins.left;
    const boxTop = doc.y;
    const boxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pad = 16;
    const innerX = boxX + pad;
    const innerW = boxW - pad * 2;
    let y = boxTop + pad;

    const line = (font, size, text, gap) => {
      doc.font(font).fontSize(size).text(text, innerX, y, { width: innerW });
      y = doc.y + (gap == null ? 4 : gap);
    };

    doc.font('krb').fontSize(15).text('전화번호 이용 승낙서', innerX, y, { width: innerW, align: 'center' });
    y = doc.y + 12;

    line('kr', 11, '발신번호 명의자는 캐치테이블 서비스 계정 명의자에게 발신번호 명의자의 아래와 같은 전화번호 사용을 허락함.', 10);
    line('kr', 11, `발신번호 명의자 정보: ${owner}`);
    line('kr', 11, '계정 명의자 정보: 주식회사 와드');
    line('kr', 11, '목적: 마케팅메세지 발송');
    line('kr', 11, `전화번호 목록: ${phones}`);
    line('kr', 11, '별첨: 아래와 같은 서류를 함께 제출할 것');
    line('kr', 11, '· 통신서비스이용증명원(전화번호 목록 내 기재되어 있는 전화번호와 모두 일치할 것)');
    line('kr', 11, '· 사업자등록증');
    line('kr', 11, '· 발신번호 명의자와 계정 명의자 간 관계를 확인할 수 있는 문서(예. 업무위수탁 계약서. 본점 – 지점 증빙서류 등)');
    line('kr', 11, '· 전화번호 목록에 임직원의 번호가 포함된 경우 해당 임직원의 재직증명서', 18);

    doc.font('kr').fontSize(11).text(today(), innerX, y, { width: innerW, align: 'right' });
    y = doc.y + 10;

    // 서명줄: "발신번호 명의자 : {대표자명} {마지막글자 손글씨}"
    doc.font('kr').fontSize(12).text('발신번호 명의자 : ', innerX, y, { width: innerW, continued: true });
    doc.text(`${owner}  `, { continued: true });
    doc.font('sign').fontSize(18).text(owner.slice(-1));
    y = doc.y;

    // 내용 높이에 맞춰 테두리 박스 그리기
    doc.lineWidth(1).rect(boxX, boxTop, boxW, y + pad - boxTop).stroke();
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
