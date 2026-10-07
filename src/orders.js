// 注文の一生：カート見積り → 決済 → 入金確認 → 業者へ送り状データ送信 → 発送通知
import { config, isDemo } from './config.js';
import { getDb } from './db.js';
import { packBoxes, boxSizeFor, shippingFee } from './packing.js';
import { shipDateFor, jstParts } from './calendar.js';
import { createCheckoutSession } from './stripe.js';
import { buildCarrierCsv, parseTrackingText } from './carriers.js';
import { sendMail } from './mailer.js';
import * as mails from './emails.js';

// Stripe アカウントで他の決済があっても混ざらないよう、
// 翔米が作った決済にだけこの印を付け、Webhook では印のあるものしか扱わない。
export const SHOP_TAG = 'shomai';

export const TIME_SLOT_VALUES = { none: '指定なし', am: '午前中', t1416: '14-16時', t1618: '16-18時', t1820: '18-20時', t1921: '19-21時' };

export class UserError extends Error {}

const productById = (id) => config.products.find((p) => p.id === id);

export async function listProducts() {
  const db = await getDb();
  const stock = Object.fromEntries((await db.all('SELECT product_id, quantity FROM stock')).map((r) => [r.product_id, r.quantity]));
  return config.products.map((p) => ({ ...p, stock: Math.max(0, stock[p.id] ?? 0) }));
}

/** カート内容を検証し、金額・箱数を計算する（金額は必ずサーバー側で計算） */
export async function quoteCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new UserError('カートが空です');
  const stock = Object.fromEntries((await listProducts()).map((p) => [p.id, p.stock]));
  const merged = new Map();
  for (const { productId, quantity } of rawItems) {
    const p = productById(productId);
    const q = Number(quantity);
    if (!p) throw new UserError('存在しない商品が含まれています');
    if (!Number.isInteger(q) || q < 1 || q > 50) throw new UserError('数量が不正です');
    merged.set(p.id, (merged.get(p.id) ?? 0) + q);
  }
  const items = [...merged].map(([id, quantity]) => {
    const p = productById(id);
    if (stock[id] < quantity) throw new UserError(`${p.name} の在庫が足りません（残り${stock[id]}）`);
    return { productId: id, name: p.name, price: p.price, weightKg: p.weightKg, quantity };
  });
  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  const boxes = packBoxes(items, config.shipping.maxBoxKg);
  const fee = shippingFee(subtotal, boxes.length, config.shipping);
  return { items, subtotal, boxCount: boxes.length, shippingFee: fee, total: subtotal + fee };
}

/** 決済ページのURLを返す */
export async function startCheckout(rawItems) {
  const quote = await quoteCart(rawItems);
  let sessionId;
  let url;
  if (isDemo()) {
    sessionId = `demo_${crypto.randomUUID()}`;
    url = `${config.baseUrl}/demo/pay?session=${sessionId}`;
  } else {
    const session = await createCheckoutSession({
      mode: 'payment',
      locale: 'ja',
      metadata: { shop: SHOP_TAG },
      payment_intent_data: { metadata: { shop: SHOP_TAG } },
      payment_method_types: config.stripe.paymentMethods,
      payment_method_options: config.stripe.paymentMethods.includes('konbini') ? { konbini: { expires_after_days: 3 } } : undefined,
      line_items: quote.items.map((i) => ({
        quantity: i.quantity,
        price_data: { currency: 'jpy', unit_amount: i.price, product_data: { name: i.name } },
      })),
      shipping_address_collection: { allowed_countries: ['JP'] },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: quote.shippingFee === 0 ? '送料無料' : `送料（${quote.boxCount}箱）`,
          fixed_amount: { amount: quote.shippingFee, currency: 'jpy' },
        },
      }],
      custom_fields: [{
        key: 'timeslot',
        label: { type: 'custom', custom: '配達時間帯' },
        type: 'dropdown',
        optional: true,
        dropdown: { options: Object.entries(TIME_SLOT_VALUES).map(([value, label]) => ({ value, label })) },
      }],
      success_url: `${config.baseUrl}/thanks.html`,
      cancel_url: `${config.baseUrl}/`,
    });
    sessionId = session.id;
    url = session.url;
  }
  const db = await getDb();
  await db.run('INSERT INTO checkouts (session_id, items_json, created_at) VALUES (?, ?, ?)', sessionId, JSON.stringify(quote.items), new Date().toISOString());
  return { url, sessionId };
}

const normalizeZip = (z) => {
  const d = String(z ?? '').replace(/\D/g, '');
  return d.length === 7 ? `${d.slice(0, 3)}-${d.slice(3)}` : String(z ?? '');
};

/** Stripe の Checkout Session をお届け先などの共通形式に変換 */
export function fromStripeSession(s) {
  const ship = s.shipping_details ?? s.collected_information?.shipping_details ?? { name: s.customer_details?.name, address: s.customer_details?.address };
  const a = ship.address ?? {};
  const slot = s.custom_fields?.find((f) => f.key === 'timeslot')?.dropdown?.value;
  return {
    sessionId: s.id,
    paid: s.payment_status === 'paid',
    email: s.customer_details?.email ?? '',
    name: ship.name ?? s.customer_details?.name ?? '',
    phone: s.customer_details?.phone ?? '',
    zip: a.postal_code,
    address1: [a.state, a.city, a.line1].filter(Boolean).join(''),
    address2: a.line2 ?? '',
    timeSlot: TIME_SLOT_VALUES[slot] ?? '指定なし',
  };
}

const getBoxes = async (db, orderId) => db.all('SELECT * FROM boxes WHERE order_id = ? ORDER BY box_no', orderId);

/**
 * 決済完了（または コンビニ払いの受付）の通知を受けて注文を作る。何度呼ばれても1件だけ作る。
 * @param {ReturnType<typeof fromStripeSession>} c
 */
export async function recordCheckout(c, now = new Date()) {
  const db = await getDb();
  const orderBySession = () => db.get('SELECT * FROM orders WHERE session_id = ?', c.sessionId);
  if (!(await orderBySession())) {
    const checkout = await db.get('SELECT * FROM checkouts WHERE session_id = ?', c.sessionId);
    if (!checkout) throw new Error(`不明な決済セッション: ${c.sessionId}`);
    const items = JSON.parse(checkout.items_json);
    const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
    const packed = packBoxes(items, config.shipping.maxBoxKg);
    const fee = shippingFee(subtotal, packed.length, config.shipping);
    const ymd = jstParts(now).date.replaceAll('-', '');
    const orderId = '(SELECT id FROM orders WHERE session_id = ?)';

    // 注文・注文番号・箱をまとめて登録（同じ通知が同時に2回来ても、2回目は session_id の重複で取り消される）
    const [inserted] = await db.batch([
      [`INSERT OR IGNORE INTO orders
        (order_no, session_id, status, email, name, phone, zip, address1, address2, time_slot, items_json,
         subtotal, shipping_fee, total, carrier, created_at)
        VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `tmp-${c.sessionId}`, c.sessionId, c.email, c.name, c.phone, normalizeZip(c.zip), c.address1, c.address2,
      c.timeSlot, checkout.items_json, subtotal, fee, subtotal + fee, config.shipping.defaultCarrier, now.toISOString()],
      [`UPDATE orders SET order_no = 'SHO-' || ? || '-' || printf('%04d', id) WHERE session_id = ? AND order_no = ?`, ymd, c.sessionId, `tmp-${c.sessionId}`],
      ...packed.map((b, i) => [
        `INSERT INTO boxes (order_id, box_no, weight_kg, size, contents_json)
         SELECT ${orderId}, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM boxes WHERE order_id = ${orderId} AND box_no = ?)`,
        c.sessionId, i + 1, b.weightKg, boxSizeFor(b.weightKg), JSON.stringify(b.contents), c.sessionId, i + 1,
      ]),
    ]);
    if (inserted.changes && !c.paid) await sendMail(mails.awaitingPaymentMail(await orderBySession()));
  }
  if (c.paid) return markPaid(c.sessionId, now);
  return orderBySession();
}

/** 入金確認：発送日を決めて在庫を引き当て、お客様へ確認メール。何度呼ばれても1回だけ効く。 */
export async function markPaid(sessionId, now = new Date()) {
  const db = await getDb();
  const order = await db.get('SELECT * FROM orders WHERE session_id = ?', sessionId);
  if (!order) throw new Error(`注文が見つかりません: ${sessionId}`);
  if (order.status !== 'awaiting_payment') return order;

  // 状態の更新と在庫の引き当てを1つのまとまりで。nonce で「この呼び出しが入金にした」場合だけ在庫を減らす。
  const nonce = crypto.randomUUID();
  const [updated] = await db.batch([
    ["UPDATE orders SET status = 'paid', paid_at = ?, ship_date = ?, pay_nonce = ? WHERE session_id = ? AND status = 'awaiting_payment'",
      now.toISOString(), shipDateFor(now, config.shipping), nonce, sessionId],
    ...JSON.parse(order.items_json).map((i) => [
      'UPDATE stock SET quantity = quantity - ? WHERE product_id = ? AND EXISTS (SELECT 1 FROM orders WHERE session_id = ? AND pay_nonce = ?)',
      i.quantity, i.productId, sessionId, nonce,
    ]),
  ]);
  const paid = await db.get('SELECT * FROM orders WHERE session_id = ?', sessionId);
  if (updated.changes) await sendMail(mails.orderConfirmedMail(paid));
  return paid;
}

/** コンビニ払いの期限切れ・失敗 */
export async function cancelUnpaid(sessionId) {
  const db = await getDb();
  await db.run("UPDATE orders SET status = 'canceled' WHERE session_id = ? AND status = 'awaiting_payment'", sessionId);
}

async function stockAlerts() {
  return (await listProducts()).filter((p) => p.stock <= 5).map((p) => `・${p.name}：残り${p.stock}`);
}

/**
 * 締め時刻の処理：発送日が来た入金済み注文をまとめ、
 * 業者へ送り状データ＋集荷依頼、店主へ梱包リストを送る。
 */
export async function dispatchBatch(date) {
  const db = await getDb();
  const orders = await db.all("SELECT * FROM orders WHERE status = 'paid' AND ship_date <= ? ORDER BY id", date);
  if (orders.length === 0) return { orders: 0 };

  const shipments = [];
  for (const order of orders) shipments.push({ order: { ...order, ship_date: date }, boxes: await getBoxes(db, order.id) });
  const byCarrier = Object.groupBy(shipments, (s) => s.order.carrier);
  const csvs = [];
  for (const [carrier, list] of Object.entries(byCarrier)) {
    const rows = list.flatMap(({ order, boxes }) => boxes.map((box) => ({ order, box: { ...box, key: `${order.order_no}-${box.box_no}` }, boxCount: boxes.length })));
    const csv = buildCarrierCsv(carrier, rows);
    csvs.push({ carrier, csv });
    await sendMail(mails.carrierRequestMail(carrier, date, rows.length, csv));
  }

  const nowIso = new Date().toISOString();
  await db.batch(orders.map((o) => ["UPDATE orders SET status = 'sent_to_carrier', ship_date = ?, sent_to_carrier_at = ? WHERE id = ? AND status = 'paid'", date, nowIso, o.id]));

  const packing = mails.packingListMail(date, shipments, await stockAlerts());
  packing.attachments = csvs.map(({ carrier, csv }) => ({ filename: `${carrier}-${date}.csv`, content: csv }));
  await sendMail(packing);
  return { orders: orders.length, boxes: shipments.reduce((n, s) => n + s.boxes.length, 0) };
}

/** 発送日の夕方：集荷済みとして「発送しました」メール */
export async function markShipped(date) {
  const db = await getDb();
  const orders = await db.all("SELECT * FROM orders WHERE status = 'sent_to_carrier' AND ship_date <= ? ORDER BY id", date);
  for (const order of orders) {
    const { changes } = await db.run("UPDATE orders SET status = 'shipped', shipped_at = ? WHERE id = ? AND status = 'sent_to_carrier'", new Date().toISOString(), order.id);
    if (changes) await sendMail(mails.shippedMail(order, await getBoxes(db, order.id)));
  }
  return { orders: orders.length };
}

/** 業者から返ってきた伝票番号を取り込む。発送済みの注文にはお問い合わせ番号を通知。 */
export async function importTracking(text) {
  const db = await getDb();
  const touched = new Set();
  let updated = 0;
  for (const { key, trackingNo } of parseTrackingText(text)) {
    const [, ymd, id, boxNo] = key.match(/^SHO-(\d{8})-(\d+)-(\d+)$/);
    const order = await db.get('SELECT * FROM orders WHERE order_no = ?', `SHO-${ymd}-${id}`);
    if (!order) continue;
    const r = await db.run('UPDATE boxes SET tracking_no = ? WHERE order_id = ? AND box_no = ? AND (tracking_no IS NULL OR tracking_no != ?)',
      trackingNo, order.id, Number(boxNo), trackingNo);
    if (r.changes) {
      updated++;
      touched.add(order.id);
    }
  }
  for (const id of touched) {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
    if (order.status === 'shipped') await sendMail(mails.trackingMail(order, await getBoxes(db, id)));
  }
  return { updated };
}

export async function ordersForAdmin() {
  const db = await getDb();
  const orders = await db.all("SELECT * FROM orders WHERE status != 'canceled' ORDER BY (status = 'shipped'), ship_date, id DESC LIMIT 200");
  const result = [];
  for (const o of orders) {
    const boxes = (await getBoxes(db, o.id)).map((b) => ({ ...b, contents: JSON.parse(b.contents_json) }));
    result.push({ ...o, items: JSON.parse(o.items_json), boxes });
  }
  return result;
}

export async function setBoxPacked(boxId, packed) {
  const db = await getDb();
  await db.run('UPDATE boxes SET packed = ? WHERE id = ?', packed ? 1 : 0, boxId);
}

export async function setCarrier(orderId, carrier) {
  if (!config.shipping.carriers[carrier]) throw new UserError('不明な配送業者');
  const db = await getDb();
  await db.run("UPDATE orders SET carrier = ? WHERE id = ? AND status IN ('awaiting_payment', 'paid')", carrier, orderId);
}

export async function setStock(productId, quantity) {
  if (!productById(productId) || !Number.isInteger(quantity) || quantity < 0) throw new UserError('在庫数が不正です');
  const db = await getDb();
  await db.run('UPDATE stock SET quantity = ? WHERE product_id = ?', quantity, productId);
}
