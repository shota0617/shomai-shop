// メール送信。RESEND_API_KEY があれば Resend で送信、なければ data/outbox/ に保存（デモ・確認用）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * @param {{to:string|string[], subject:string, text:string, attachments?:{filename:string, content:Buffer}[]}} msg
 */
export async function sendMail(msg) {
  const to = [msg.to].flat().filter(Boolean);
  if (to.length === 0) return;

  if (!config.mail.resendApiKey) {
    const dir = path.join(config.dataDir, 'outbox');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}.eml`);
    const attachNote = (msg.attachments ?? []).map((a) => `[添付: ${a.filename}]`).join('\n');
    writeFileSync(file, `To: ${to.join(', ')}\nSubject: ${msg.subject}\n\n${msg.text}\n${attachNote}\n`);
    for (const a of msg.attachments ?? []) writeFileSync(`${file}.${a.filename}`, a.content);
    console.log(`[mail:outbox] ${msg.subject} → ${to.join(', ')}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.mail.from,
      to,
      subject: msg.subject,
      text: msg.text,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
    }),
  });
  if (!res.ok) throw new Error(`メール送信失敗 (${res.status}): ${await res.text()}`);
}
