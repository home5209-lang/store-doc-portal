const fs = require('fs');
const path = require('path');

const MODUSIGN_API_BASE = 'https://api.modusign.co.kr';

function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, '') // 공백 제거
    .replace(/[()]/g, '') // 괄호 제거
    .toLowerCase();
}

function authHeader() {
  const email = process.env.MODUSIGN_EMAIL;
  const apiKey = process.env.API_KEY;
  if (!email || !apiKey) {
    throw new Error('MODUSIGN_EMAIL, API_KEY 환경변수가 설정되어 있지 않습니다.');
  }
  const encoded = Buffer.from(`${email}:${apiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

async function modusignGet(pathAndQuery) {
  const res = await fetch(`${MODUSIGN_API_BASE}${pathAndQuery}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader()
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`모두싸인 API 오류 (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// 서명 완료된 문서 목록에서, 참여자 이름이 매장명과 일치하는 문서를 찾는다.
// (실제 서비스에서는 계약 생성 시 문서에 매장 고유 ID를 metadata로 심어두고
//  그 metadata로 조회하는 방식이 훨씬 안정적입니다 — 이름 매칭은 동명 매장,
//  표기 차이(공백/괄호 등)에 취약한 임시방편입니다.)
async function findCompletedDocumentByStoreName(storeName, { maxPages = 5, pageSize = 100 } = {}) {
  const target = normalizeName(storeName);
  if (!target) return null;

  const filter = encodeURIComponent("status eq 'COMPLETED'");
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const data = await modusignGet(`/documents?offset=${offset}&limit=${pageSize}&filter=${filter}`);
    const documents = data.documents || data.items || data;
    if (!Array.isArray(documents) || documents.length === 0) break;

    for (const doc of documents) {
      const participants = doc.participants || [];
      const matched = participants.some((p) => normalizeName(p.name) === target);
      if (matched) return doc.id || doc.documentId;
    }

    if (documents.length < pageSize) break; // 마지막 페이지
  }
  return null;
}

async function downloadSignedPdf(documentId, outPath) {
  const detail = await modusignGet(`/documents/${documentId}`);
  const downloadUrl = detail?.file?.downloadUrl;
  if (!downloadUrl) {
    throw new Error('완료 문서에서 downloadUrl을 찾지 못했습니다. (문서가 아직 완료 상태가 아닐 수 있습니다)');
  }

  // downloadUrl은 발급 후 10분만 유효하므로 바로 받아야 한다.
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`계약서 파일 다운로드 실패 (${fileRes.status})`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
}

// server.js에서 호출하는 진입점. 매칭 실패 시에도 서류 제출 흐름 자체는 막지 않고,
// 안내 텍스트를 대신 남겨서 운영자가 수동으로 확인/재시도할 수 있게 한다.
async function fetchContractFromModusign(store, outPath) {
  try {
    const documentId = await findCompletedDocumentByStoreName(store.name);
    if (!documentId) {
      const notice =
        `[자동 매칭 실패]\n\n` +
        `"${store.name}" 이름과 정확히 일치하는 서명 완료 계약서를 모두싸인에서 찾지 못했습니다.\n` +
        `매장명 표기가 다르거나(공백/특수문자), 아직 서명이 완료되지 않았을 수 있습니다.\n` +
        `운영자가 모두싸인에서 직접 확인 후 수동으로 첨부해주세요.\n`;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath.replace(/\.pdf$/i, '.txt'), notice, 'utf-8');
      return { matched: false };
    }

    const pdfPath = outPath.replace(/\.txt$/i, '.pdf');
    await downloadSignedPdf(documentId, pdfPath);
    return { matched: true, documentId, path: pdfPath };
  } catch (err) {
    const notice =
      `[모두싸인 연동 오류]\n\n${err.message}\n\n` +
      `운영자가 모두싸인에서 직접 확인 후 수동으로 첨부해주세요.\n`;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath.replace(/\.pdf$/i, '.txt'), notice, 'utf-8');
    return { matched: false, error: err.message };
  }
}

module.exports = { fetchContractFromModusign, findCompletedDocumentByStoreName, downloadSignedPdf };
