// メール送信。RESEND_API_KEY があれば Resend で送信、なければ「控え」に回す（デモ・確認用）。
// 控えの行き先は動かす環境が決める：Node.js は data/outbox/ にファイル保存、Cloudflare はログに出す。
import { config } from './config.js';

let fallback = async (msg) => {
  console.log(`[mail:未送信] ${msg.subject} → ${[msg.to].flat().join(', ')}\n${msg.text}`);
};

/** RESEND_API_KEY が無いときの控えの処理を差し替える */
export function setMailFallback(fn) {
  fallback = fn;
}

/**
 * @param {{to:string|string[], subject:string, text:string, attachments?:{filename:string, content:Uint8Array}[]}} msg
 */
export async function sendMail(msg) {
  const to = [msg.to].flat().filter(Boolean);
  if (to.length === 0) return;
  if (!config.mail.resendApiKey) return fallback({ ...msg, to });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.mail.from,
      to,
      subject: msg.subject,
      text: msg.text,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
    }),
  });
  if (!res.ok) throw new Error(`メール送信失敗 (${res.status}): ${await res.text()}`);
}
