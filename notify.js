'use strict';

// 슬랙 알림 (Incoming Webhook). 외부 패키지 없이 전역 fetch 사용.
// SLACK_WEBHOOK_URL 이 설정돼 있을 때만 전송하며, 실패해도 앱 흐름을 막지 않는다.

function isConfigured() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

async function notifySlack(text, log = console.log) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false; // 미설정이면 조용히 통과
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      log(`[slack] 알림 실패 (${res.status})`);
      return false;
    }
    return true;
  } catch (e) {
    log(`[slack] 알림 오류: ${e.message}`);
    return false;
  }
}

module.exports = { isConfigured, notifySlack };
