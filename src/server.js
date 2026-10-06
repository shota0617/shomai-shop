import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, isDemo, ROOT } from './config.js';
import { getDb } from './db.js';
import { verifyWebhook, retrieveCheckoutSession } from './stripe.js';
import { renderAdmin, esc } from './admin.js';
import { startScheduler, tick } from './jobs.js';
import * as orders from './orders.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new orders.UserError('リクエストが大きすぎます');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch {
    throw new orders.UserError('JSONが不正です');
  }
}

function isAdmin(req) {
  if (!config.admin.password) return isDemo(); // 本番ではパスワード必須
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const given = Buffer.from(`${Buffer.from(encoded, 'base64').toString()}`);
  const expected = Buffer.from(`${config.admin.user}:${config.admin.password}`);
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not Found', 'text/plain');
  try {
    send(res, 200, await readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }
}

async function handleStripeWebhook(req, res) {
  const raw = await readBody(req);
  let event;
  try {
    event = verifyWebhook(raw, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const obj = event.data?.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // イベント本文ではなくAPIから最新の内容を取り直す（APIバージョン差異も吸収）
      const session = await retrieveCheckoutSession(obj.id);
      await orders.recordCheckout(orders.fromStripeSession(session));
      break;
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      orders.cancelUnpaid(obj.id);
      break;
  }
  send(res, 200, { received: true });
}

function demoPayPage(sessionId) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>デモ決済</title>
<style>body{font-family:sans-serif;background:#f5f2eb;padding:16px;color:#2d2d1e}form{max-width:420px;margin:auto;background:#fff;padding:18px;border-radius:14px}
label{display:block;font-size:12px;margin-top:10px}input,select{width:100%;padding:8px;font-size:15px;border:1.5px solid #c4bfaa;border-radius:8px}
button{margin-top:16px;width:100%;padding:14px;background:#c8a96e;border:none;border-radius:10px;font-weight:700;font-size:15px}.n{background:#fff8ee;padding:10px;border-radius:8px;font-size:12px}</style></head>
<body><form method="post" action="/demo/pay">
<p class="n">これはデモ用の擬似決済画面です。本番では Stripe の決済画面（カード・コンビニ払い）に置き換わります。</p>
<input type="hidden" name="session" value="${esc(sessionId)}">
<label>お名前<input name="name" value="山田 花子" required></label>
<label>メール<input name="email" type="email" value="hanako@example.com" required></label>
<label>電話番号<input name="phone" value="090-1234-5678" required></label>
<label>郵便番号<input name="zip" value="4600001" required></label>
<label>住所<input name="address1" value="愛知県名古屋市中区三の丸1-1-1" required></label>
<label>建物名・部屋番号<input name="address2" value=""></label>
<label>配達時間帯<select name="slot">${Object.entries(orders.TIME_SLOT_VALUES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
<button>支払う（デモ）</button></form></body></html>`;
}

async function route(req, res) {
  const url = new URL(req.url, config.baseUrl);
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/products') {
    return send(res, 200, { products: orders.listProducts(), shipping: { feePerBox: config.shipping.feePerBox, freeShippingFrom: config.shipping.freeShippingFrom, maxBoxKg: config.shipping.maxBoxKg }, demo: isDemo() });
  }
  if (method === 'POST' && pathname === '/api/quote') {
    return send(res, 200, orders.quoteCart((await readJson(req)).items));
  }
  if (method === 'POST' && pathname === '/api/checkout') {
    const { url: checkoutUrl } = await orders.startCheckout((await readJson(req)).items);
    return send(res, 200, { url: checkoutUrl });
  }
  if (method === 'POST' && pathname === '/webhooks/stripe') return handleStripeWebhook(req, res);

  if (method === 'GET' && pathname === '/legal') {
    const rows = Object.entries(config.shop.legal).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    return send(res, 200, `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>特定商取引法に基づく表記｜翔米</title>
<style>body{font-family:sans-serif;background:#f5f2eb;color:#2d2d1e;padding:16px;line-height:1.7}main{max-width:640px;margin:auto}table{border-collapse:collapse;background:#fff;width:100%}th,td{border:1px solid #e8e4d8;padding:10px;font-size:14px;text-align:left;vertical-align:top}th{width:32%;background:#faf8f2}</style></head>
<body><main><h1 style="font-size:18px">特定商取引法に基づく表記</h1><table>${rows}</table><p><a href="/">← 翔米 トップへ</a></p></main></body></html>`, 'text/html; charset=utf-8');
  }

  if (isDemo() && pathname === '/demo/pay') {
    if (method === 'GET') return send(res, 200, demoPayPage(url.searchParams.get('session') ?? ''), 'text/html; charset=utf-8');
    if (method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      await orders.recordCheckout({
        sessionId: f.get('session'), paid: true, email: f.get('email'), name: f.get('name'), phone: f.get('phone'),
        zip: f.get('zip'), address1: f.get('address1'), address2: f.get('address2') ?? '', timeSlot: orders.TIME_SLOT_VALUES[f.get('slot')] ?? '指定なし',
      });
      return send(res, 303, '', 'text/plain', { Location: '/thanks.html' });
    }
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (!isAdmin(req)) {
      if (!config.admin.password) return send(res, 503, 'ADMIN_PASSWORD を設定してください', 'text/plain; charset=utf-8');
      return send(res, 401, '認証が必要です', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="shomai-admin", charset="UTF-8"' });
    }
    if (method === 'GET' && pathname === '/admin') {
      return send(res, 200, renderAdmin({ orders: orders.ordersForAdmin(), products: orders.listProducts() }), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && pathname.startsWith('/admin/api/')) {
      // 別サイトからの なりすまし送信 を防ぐ（このヘッダーはフォーム送信では付けられない）
      if (req.headers['x-requested-with'] !== 'shomai') return send(res, 403, { error: 'forbidden' });
      const body = await readJson(req);
      switch (pathname) {
        case '/admin/api/packed': orders.setBoxPacked(Number(body.boxId), !!body.packed); return send(res, 200, { ok: true });
        case '/admin/api/carrier': orders.setCarrier(Number(body.orderId), body.carrier); return send(res, 200, { ok: true });
        case '/admin/api/stock': orders.setStock(body.productId, body.quantity); return send(res, 200, { ok: true });
        case '/admin/api/tracking': {
          const r = await orders.importTracking(String(body.text ?? ''));
          return send(res, 200, { message: `${r.updated}件の伝票番号を取り込みました`, reload: true });
        }
        case '/admin/api/run-jobs': await tick(); return send(res, 200, { ok: true, reload: true });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  if (method === 'GET' || method === 'HEAD') return serveStatic(res, decodeURIComponent(pathname));
  send(res, 405, { error: 'method not allowed' });
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof orders.UserError) return send(res, 400, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'サーバーエラーが発生しました' });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getDb();
  if (!isDemo() && !config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET を設定してください');
  createServer().listen(config.port, () => {
    console.log(`翔米ショップ起動: ${config.baseUrl}${isDemo() ? '（デモモード：Stripe未設定）' : ''}`);
    console.log(`管理画面: ${config.baseUrl}/admin`);
  });
  startScheduler();
}
