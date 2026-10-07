// 画面・API・Stripe Webhook。Web 標準の Request → Response で書いてあり、
// Cloudflare Workers（src/worker.js）と Node.js（src/node.js）の両方から呼ばれる。
// 商品ページなどの静的ファイル（public/）は、それぞれの環境が先に返す。
import crypto from 'node:crypto';
import { config, isDemo } from './config.js';
import { verifyWebhook, retrieveCheckoutSession } from './stripe.js';
import { renderAdmin, esc } from './admin.js';
import { tick } from './jobs.js';
import * as orders from './orders.js';

const BODY_LIMIT = 1_000_000;

const respond = (status, body, type = 'application/json; charset=utf-8', headers = {}) =>
  new Response(status === 303 ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers },
  });
const html = (body, headers = {}) => respond(200, body, 'text/html; charset=utf-8', headers);

async function readText(request) {
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new orders.UserError('リクエストが大きすぎます');
  return text;
}

async function readJson(request) {
  const text = await readText(request);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new orders.UserError('JSONが不正です');
  }
}

function isAdmin(request) {
  if (!config.admin.password) return isDemo(); // 本番ではパスワード必須
  const [scheme, encoded] = (request.headers.get('authorization') ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(Buffer.from(encoded, 'base64').toString()), digest(`${config.admin.user}:${config.admin.password}`));
}

async function handleStripeWebhook(request) {
  const raw = await readText(request);
  let event;
  try {
    event = verifyWebhook(raw, request.headers.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    return respond(400, { error: e.message });
  }
  const obj = event.data?.object;
  // 翔米以外（同じStripeアカウントの別の決済）は何もせず受け取りだけ返す
  if (obj?.object === 'checkout.session' && obj.metadata?.shop !== orders.SHOP_TAG) return respond(200, { received: true, ignored: true });
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
      await orders.cancelUnpaid(obj.id);
      break;
  }
  return respond(200, { received: true });
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

function legalPage() {
  const rows = Object.entries(config.shop.legal).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>特定商取引法に基づく表記｜翔米</title>
<style>body{font-family:sans-serif;background:#f5f2eb;color:#2d2d1e;padding:16px;line-height:1.7}main{max-width:640px;margin:auto}table{border-collapse:collapse;background:#fff;width:100%}th,td{border:1px solid #e8e4d8;padding:10px;font-size:14px;text-align:left;vertical-align:top}th{width:32%;background:#faf8f2}</style></head>
<body><main><h1 style="font-size:18px">特定商取引法に基づく表記</h1><table>${rows}</table><p><a href="/">← 翔米 トップへ</a></p></main></body></html>`;
}

async function route(request) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/products') {
    const { feePerBox, freeShippingFrom, maxBoxKg } = config.shipping;
    return respond(200, { products: await orders.listProducts(), shipping: { feePerBox, freeShippingFrom, maxBoxKg }, demo: isDemo() });
  }
  if (method === 'POST' && pathname === '/api/quote') return respond(200, await orders.quoteCart((await readJson(request)).items));
  if (method === 'POST' && pathname === '/api/checkout') {
    const { url: checkoutUrl } = await orders.startCheckout((await readJson(request)).items);
    return respond(200, { url: checkoutUrl });
  }
  if (method === 'POST' && pathname === '/webhooks/stripe') return handleStripeWebhook(request);
  if (method === 'GET' && pathname === '/legal') return html(legalPage());

  if (isDemo() && pathname === '/demo/pay') {
    if (method === 'GET') return html(demoPayPage(url.searchParams.get('session') ?? ''));
    if (method === 'POST') {
      const f = new URLSearchParams(await readText(request));
      const v = (k) => f.get(k) ?? '';
      await orders.recordCheckout({
        sessionId: v('session'), paid: true, email: v('email'), name: v('name'), phone: v('phone'),
        zip: v('zip'), address1: v('address1'), address2: v('address2'), timeSlot: orders.TIME_SLOT_VALUES[v('slot')] ?? '指定なし',
      });
      return respond(303, null, 'text/plain', { Location: '/thanks.html' });
    }
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (!isAdmin(request)) {
      if (!config.admin.password) return respond(503, 'ADMIN_PASSWORD を設定してください', 'text/plain; charset=utf-8');
      return respond(401, '認証が必要です', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="shomai-admin", charset="UTF-8"' });
    }
    if (method === 'GET' && pathname === '/admin') {
      return html(renderAdmin({ orders: await orders.ordersForAdmin(), products: await orders.listProducts() }), { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && pathname.startsWith('/admin/api/')) {
      // 別サイトからの なりすまし送信 を防ぐ（このヘッダーはフォーム送信では付けられない）
      if (request.headers.get('x-requested-with') !== 'shomai') return respond(403, { error: 'forbidden' });
      const body = await readJson(request);
      switch (pathname) {
        case '/admin/api/packed': await orders.setBoxPacked(Number(body.boxId), !!body.packed); return respond(200, { ok: true });
        case '/admin/api/carrier': await orders.setCarrier(Number(body.orderId), body.carrier); return respond(200, { ok: true });
        case '/admin/api/stock': await orders.setStock(body.productId, body.quantity); return respond(200, { ok: true });
        case '/admin/api/tracking': {
          const r = await orders.importTracking(String(body.text ?? ''));
          return respond(200, { message: `${r.updated}件の伝票番号を取り込みました`, reload: true });
        }
        case '/admin/api/run-jobs': await tick(); return respond(200, { ok: true, reload: true });
      }
    }
    return respond(404, { error: 'not found' });
  }

  return respond(404, 'Not Found', 'text/plain; charset=utf-8');
}

/** @param {Request} request */
export async function handle(request) {
  try {
    return await route(request);
  } catch (e) {
    if (e instanceof orders.UserError) return respond(400, { error: e.message });
    console.error(e);
    return respond(500, { error: 'サーバーエラーが発生しました' });
  }
}
