import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { tick } from '../src/jobs.js';
import { listProducts } from '../src/orders.js';

const outbox = path.join(config.dataDir, 'outbox');
const mails = () => {
  try {
    return readdirSync(outbox).filter((f) => f.endsWith('.eml')).sort().map((f) => readFileSync(path.join(outbox, f), 'utf8'));
  } catch { return []; }
};
const clearMails = () => rmSync(outbox, { recursive: true, force: true });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
config.baseUrl = base;
test.after(() => server.close());

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

test('注文 → 入金 → 締め時刻に業者へ送り状データ → 伝票番号取込 → 夕方に発送通知', async () => {
  clearMails();
  const stockBefore = Object.fromEntries(listProducts().map((p) => [p.id, p.stock]));

  // お客様：10kg×2 と 5kg×1 をカートに入れて購入手続き
  const items = [{ productId: 'shomai-10kg', quantity: 2 }, { productId: 'shomai-5kg', quantity: 1 }];
  const quote = await (await post('/api/quote', { items })).json();
  assert.equal(quote.boxCount, 2);
  assert.equal(quote.shippingFee, 0); // 1万円以上で無料
  const { url } = await (await post('/api/checkout', { items })).json();
  const session = new URL(url).searchParams.get('session');

  // デモ決済（本番では Stripe → Webhook）
  const paid = await fetch(`${base}/demo/pay`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ session, name: '山田 花子', email: 'hanako@example.com', phone: '090-1111-2222', zip: '4600001', address1: '愛知県名古屋市中区三の丸1-1', address2: '', slot: 't1820' }),
  });
  assert.equal(paid.status, 303);

  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE session_id = ?').get(session);
  assert.equal(order.status, 'paid');
  assert.equal(order.zip, '460-0001');
  assert.equal(order.time_slot, '18-20時');
  assert.match(order.order_no, /^SHO-\d{8}-\d{4}$/);
  const stockAfter = Object.fromEntries(listProducts().map((p) => [p.id, p.stock]));
  assert.equal(stockAfter['shomai-10kg'], stockBefore['shomai-10kg'] - 2);
  assert.match(mails().at(-1), /ご注文ありがとうございます/);

  // 同じ決済通知がもう一度来ても二重にならない
  await fetch(`${base}/demo/pay`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ session, name: 'x', email: 'x@example.com', phone: '0', zip: '0', address1: 'x' }) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE session_id = ?').get(session).n, 1);
  assert.equal(listProducts().find((p) => p.id === 'shomai-10kg').stock, stockAfter['shomai-10kg']);

  // 発送日の締め時刻：業者へCSV、店主へ梱包リスト
  clearMails();
  const shipDay = new Date(`${order.ship_date}T12:00:00+09:00`);
  await tick(shipDay);
  await tick(shipDay); // 2回目は何もしない
  const sent = mails();
  assert.equal(sent.length, 2);
  const carrierMail = sent.find((m) => m.includes('To: center@yamato.example'));
  assert.match(carrierMail, /集荷依頼・送り状データ.*2個口/);
  const ownerMail = sent.find((m) => m.includes('To: owner@shop.example'));
  assert.match(ownerMail, /本日の発送 2箱/);
  assert.match(ownerMail, /翔米 10kg×2/);
  const csvFile = readdirSync(outbox).find((f) => f.endsWith('.csv'));
  const csv = iconv.decode(readFileSync(path.join(outbox, csvFile)), 'Shift_JIS');
  assert.match(csv, new RegExp(`${order.order_no}-1,0,0,,${order.ship_date.replaceAll('-', '/')},,1820,`));
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'sent_to_carrier');

  // 管理画面（デモモードはパスワードなしで開ける）
  const admin = await (await fetch(`${base}/admin`)).text();
  assert.match(admin, /山田 花子/);

  // 管理APIはなりすまし対策ヘッダー必須
  assert.equal((await post('/admin/api/tracking', { text: '' })).status, 403);
  const imp = await (await post('/admin/api/tracking', { text: `${order.order_no}-1,412345678901\n${order.order_no}-2,412345678902` }, { 'X-Requested-With': 'shomai' })).json();
  assert.match(imp.message, /2件/);

  // 発送日の夕方：発送通知（伝票番号つき）
  clearMails();
  await tick(new Date(`${order.ship_date}T18:00:00+09:00`));
  const shipped = mails();
  assert.equal(shipped.length, 1);
  assert.match(shipped[0], /発送しました/);
  assert.match(shipped[0], /412345678901/);
  assert.match(shipped[0], /toi\.kuronekoyamato\.co\.jp/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'shipped');
});

test('在庫より多くは買えない・不正な商品は弾く', async () => {
  let r = await post('/api/checkout', { items: [{ productId: 'shomai-2kg', quantity: 50 }, { productId: 'shomai-2kg', quantity: 1 }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /在庫が足りません|数量/);
  r = await post('/api/checkout', { items: [{ productId: 'nope', quantity: 1 }] });
  assert.equal(r.status, 400);
});

test('Stripe Webhook：コンビニ払いは入金待ち → 入金で確定', async () => {
  const realFetch = globalThis.fetch;
  Object.assign(config.stripe, { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
  let paymentStatus = 'unpaid';
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s === 'https://api.stripe.com/v1/checkout/sessions' && init.method === 'POST') {
      return Response.json({ id: 'cs_test_konbini', url: 'https://checkout.stripe.com/c/pay/cs_test_konbini' });
    }
    if (s.startsWith('https://api.stripe.com/v1/checkout/sessions/cs_test_konbini')) {
      return Response.json({
        id: 'cs_test_konbini', payment_status: paymentStatus,
        customer_details: { email: 'konbini@example.com', name: '佐藤 一郎', phone: '+81312345678' },
        shipping_details: { name: '佐藤 一郎', address: { postal_code: '1000001', state: '東京都', city: '千代田区', line1: '千代田1-1', line2: null } },
        custom_fields: [],
      });
    }
    return realFetch(u, init);
  };
  try {
    const { url } = await (await post('/api/checkout', { items: [{ productId: 'shomai-2kg', quantity: 1 }] })).json();
    assert.match(url, /checkout\.stripe\.com/);

    const sendEvent = (type) => {
      const body = JSON.stringify({ type, data: { object: { id: 'cs_test_konbini' } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex');
      return realFetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
    };
    assert.equal((await realFetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': 't=1,v1=00' }, body: '{}' })).status, 400);

    clearMails();
    assert.equal((await sendEvent('checkout.session.completed')).status, 200);
    const db = getDb();
    let order = db.prepare("SELECT * FROM orders WHERE session_id = 'cs_test_konbini'").get();
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.address1, '東京都千代田区千代田1-1');
    assert.equal(order.zip, '100-0001');
    assert.match(mails().at(-1), /お支払い待ち/);

    paymentStatus = 'paid';
    assert.equal((await sendEvent('checkout.session.async_payment_succeeded')).status, 200);
    order = db.prepare("SELECT * FROM orders WHERE session_id = 'cs_test_konbini'").get();
    assert.equal(order.status, 'paid');
    assert.ok(order.ship_date);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.stripe, { secretKey: '', webhookSecret: '' });
  }
});
