// Node.js で動かすときの入口（手元での確認・テスト・Docker）。
// Cloudflare で動かすときは src/worker.js が入口になる。
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, initConfig, isDemo } from './config.js';
import { setDb, nodeSqliteAdapter } from './db.js';
import { setMailFallback } from './mailer.js';
import { tick } from './jobs.js';
import { handle } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

/** データ保存先・メールの控え先を Node.js 用に用意する */
export async function setupNode({ db = path.join(path.resolve(ROOT, config.dataDir), 'shop.db') } = {}) {
  const dataDir = path.resolve(ROOT, config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  setDb(await nodeSqliteAdapter(db));
  // メール送信サービス未設定のときは data/outbox/ に .eml で保存
  setMailFallback(async (msg) => {
    const dir = path.join(dataDir, 'outbox');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.eml`);
    const attachNote = (msg.attachments ?? []).map((a) => `[添付: ${a.filename}]`).join('\n');
    writeFileSync(file, `To: ${msg.to.join(', ')}\nSubject: ${msg.subject}\n\n${msg.text}\n${attachNote}\n`);
    for (const a of msg.attachments ?? []) writeFileSync(`${file}.${a.filename}`, a.content);
    console.log(`[mail:outbox] ${msg.subject} → ${msg.to.join(', ')}`);
  });
}

async function serveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return null;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    return { body: await readFile(file), type: MIME[path.extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.baseUrl);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = await serveStatic(url.pathname);
        if (file) {
          res.writeHead(200, { 'Content-Type': file.type, 'X-Content-Type-Options': 'nosniff' });
          return res.end(req.method === 'HEAD' ? undefined : file.body);
        }
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, [v].flat().join(', '));
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  initConfig(process.env);
  if (!isDemo() && !config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET を設定してください');
  await setupNode();
  createServer().listen(config.port, () => {
    console.log(`翔米ショップ起動: ${config.baseUrl}${isDemo() ? '（デモモード：Stripe未設定）' : ''}`);
    console.log(`管理画面: ${config.baseUrl}/admin`);
  });
  const loop = () => tick().catch((e) => console.error('[job] 失敗', e));
  loop();
  setInterval(loop, 60 * 1000);
}
