const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  HeadingLevel
} = require('docx');

function today() {
  const d = new Date();
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function noBorder() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  };
}

function infoRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 2500, type: WidthType.DXA },
        borders: noBorder(),
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })]
      }),
      new TableCell({
        width: { size: 6000, type: WidthType.DXA },
        borders: noBorder(),
        children: [new Paragraph({ children: [new TextRun({ text: value || '' })] })]
      })
    ]
  });
}

// ---------- 1. 발신번호 사용 승낙서 ----------
async function generateConsentDoc(store, outPath) {
  const doc = new Document({
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 } } },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: '발신번호 사용 승낙서', bold: true, size: 32 })]
          }),
          new Paragraph({ text: '' }),
          new Paragraph({
            children: [
              new TextRun(
                '아래 사업장은 캐치테이블(이하 "회사")이 고객 안내 문자 발송을 위한 발신번호로 아래 사업장 명의의 ' +
                '전화번호를 사용하는 것에 대하여 승낙합니다.'
              )
            ]
          }),
          new Paragraph({ text: '' }),
          new Table({
            width: { size: 8500, type: WidthType.DXA },
            rows: [
              infoRow('상호명', store.name),
              infoRow('대표자명', store.owner_name),
              infoRow('사업자등록번호', store.biz_reg_no),
              infoRow('신청 담당자', `${store.contact_name || ''} (${store.contact_title || ''})`)
            ]
          }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: '위 사업장은 상기 내용에 대해 이의 없이 승낙함을 확인합니다.' }),
          new Paragraph({ text: '' }),
          new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun(today())] }),
          new Paragraph({ text: '' }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun(`상호명: ${store.name || ''}   대표자: ${store.owner_name || ''}  (인)`)]
          })
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

// ---------- 2. 재직 증명서 ----------
async function generateEmploymentCert(store, outPath) {
  const doc = new Document({
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 } } },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: '재직 증명서', bold: true, size: 32 })]
          }),
          new Paragraph({ text: '' }),
          new Table({
            width: { size: 8500, type: WidthType.DXA },
            rows: [
              infoRow('성명', store.contact_name),
              infoRow('직위', store.contact_title),
              infoRow('소속(상호명)', store.name),
              infoRow('사업자등록번호', store.biz_reg_no)
            ]
          }),
          new Paragraph({ text: '' }),
          new Paragraph({
            children: [new TextRun('위 사람은 상기 사업장에 재직 중임을 증명합니다.')]
          }),
          new Paragraph({ text: '' }),
          new Paragraph({ children: [new TextRun('용도: 발신번호 등록 심사 제출용')] }),
          new Paragraph({ text: '' }),
          new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun(today())] }),
          new Paragraph({ text: '' }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun(`상호명: ${store.name || ''}   대표자: ${store.owner_name || ''}  (인)`)]
          })
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

module.exports = { generateConsentDoc, generateEmploymentCert };
