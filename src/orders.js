// 注文の一生：カート見積り → 決済 → 入金確認 → 業者へ送り状データ送信 → 発送通知
import crypto from 'node:crypto';
import { config, isDemo } from './config.js';
import { getDb, tx } from './db.js';
import { packBoxes, boxSizeFor, shippingFee } from './packing.js';
import { shipDateFor, jstParts } from './calendar.js';
import { createCheckoutSession } from './stripe.js';
import { buildCarrierCsv, parseTrackingText } from './carriers.js';
import { sendMail } from './mailer.js';
import * as mails from './emails.js';

export const TIME_SLOT_VALUES = { none: '指定なし', am: '午前中', t1416: '14-16時', t1618: '16-18時', t1820: '18-20時', t1921: '19-21時' };

export class UserError extends Error {}

const productById = (id) => config.products.find((p) => p.id === id);

export function listProducts() {
  const stock = Object.fromEntries(getDb().prepare('SELECT product_id, quantity FROM stock').all().map((r) => [r.product_id, r.quantity]));
  return config.products.map((p) => ({ ...p, stock: Math.max(0, stock[p.id] ?? 0) }));
}

/** カート内容を検証し、金額・箱数を計算する（金額は必ずサーバー側で計算） */
export function quoteCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new UserError('カートが空です');
  const stock = Object.fromEntries(listProducts().map((p) => [p.id, p.stock]));
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
  const quote = quoteCart(rawItems);
  let sessionId;
  let url;
  if (isDemo()) {
    sessionId = `demo_${crypto.randomUUID()}`;
    url = `${config.baseUrl}/demo/pay?session=${sessionId}`;
  } else {
    const session = await createCheckoutSession({
      mode: 'payment',
      locale: 'ja',
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
  getDb().prepare('INSERT INTO checkouts (session_id, items_json, created_at) VALUES (?, ?, ?)')
    .run(sessionId, JSON.stringify(quote.items), new Date().toISOString());
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

const getOrderBySession = (sessionId) => getDb().prepare('SELECT * FROM orders WHERE session_id = ?').get(sessionId);
const getBoxes = (orderId) => getDb().prepare('SELECT * FROM boxes WHERE order_id = ? ORDER BY box_no').all(orderId);

/**
 * 決済完了（または コンビニ払いの受付）の通知を受けて注文を作る。何度呼ばれても1件だけ作る。
 * @param {ReturnType<typeof fromStripeSession>} c
 */
export async function recordCheckout(c, now = new Date()) {
  let order = getOrderBySession(c.sessionId);
  if (!order) {
    const checkout = getDb().prepare('SELECT * FROM checkouts WHERE session_id = ?').get(c.sessionId);
    if (!checkout) throw new Error(`不明な決済セッション: ${c.sessionId}`);
    const items = JSON.parse(checkout.items_json);
    const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
    const packed = packBoxes(items, config.shipping.maxBoxKg);
    const fee = shippingFee(subtotal, packed.length, config.shipping);

    order = tx((db) => {
      const r = db.prepare(`INSERT INTO orders
        (order_no, session_id, status, email, name, phone, zip, address1, address2, time_slot, items_json,
         subtotal, shipping_fee, total, carrier, created_at)
        VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `tmp-${c.sessionId}`, c.sessionId, c.email, c.name, c.phone, normalizeZip(c.zip), c.address1, c.address2,
        c.timeSlot, checkout.items_json, subtotal, fee, subtotal + fee, config.shipping.defaultCarrier, now.toISOString(),
      );
      const id = Number(r.lastInsertRowid);
      const orderNo = `SHO-${jstParts(now).date.replaceAll('-', '')}-${String(id).padStart(4, '0')}`;
      db.prepare('UPDATE orders SET order_no = ? WHERE id = ?').run(orderNo, id);
      const insBox = db.prepare('INSERT INTO boxes (order_id, box_no, weight_kg, size, contents_json) VALUES (?, ?, ?, ?, ?)');
      packed.forEach((b, i) => insBox.run(id, i + 1, b.weightKg, boxSizeFor(b.weightKg), JSON.stringify(b.contents)));
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    });
    if (!c.paid) await sendMail(mails.awaitingPaymentMail(order));
  }
  if (c.paid) return markPaid(c.sessionId, now);
  return order;
}

/** 入金確認：発送日を決めて在庫を引き当て、お客様へ確認メール */
export async function markPaid(sessionId, now = new Date()) {
  const result = tx((db) => {
    const order = db.prepare('SELECT * FROM orders WHERE session_id = ?').get(sessionId);
    if (!order) throw new Error(`注文が見つかりません: ${sessionId}`);
    if (order.status !== 'awaiting_payment') return { order, changed: false };
    const shipDate = shipDateFor(now, config.shipping);
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, ship_date = ? WHERE id = ?").run(now.toISOString(), shipDate, order.id);
    const dec = db.prepare('UPDATE stock SET quantity = quantity - ? WHERE product_id = ?');
    for (const i of JSON.parse(order.items_json)) dec.run(i.quantity, i.productId);
    return { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), changed: true };
  });
  if (result.changed) await sendMail(mails.orderConfirmedMail(result.order));
  return result.order;
}

/** コンビニ払いの期限切れ・失敗 */
export function cancelUnpaid(sessionId) {
  getDb().prepare("UPDATE orders SET status = 'canceled' WHERE session_id = ? AND status = 'awaiting_payment'").run(sessionId);
}

function stockAlerts() {
  return listProducts().filter((p) => p.stock <= 5).map((p) => `・${p.name}：残り${p.stock}`);
}

/**
 * 締め時刻の処理：発送日が来た入金済み注文をまとめ、
 * 業者へ送り状データ＋集荷依頼、店主へ梱包リストを送る。
 */
export async function dispatchBatch(date) {
  const db = getDb();
  const orders = db.prepare("SELECT * FROM orders WHERE status = 'paid' AND ship_date <= ? ORDER BY id").all(date);
  if (orders.length === 0) return { orders: 0 };

  const shipments = orders.map((order) => ({ order: { ...order, ship_date: date }, boxes: getBoxes(order.id) }));
  const byCarrier = Object.groupBy(shipments, (s) => s.order.carrier);
  const csvs = [];
  for (const [carrier, list] of Object.entries(byCarrier)) {
    const rows = list.flatMap(({ order, boxes }) => boxes.map((box) => ({ order, box: { ...box, key: `${order.order_no}-${box.box_no}` }, boxCount: boxes.length })));
    const csv = buildCarrierCsv(carrier, rows);
    csvs.push({ carrier, csv });
    await sendMail(mails.carrierRequestMail(carrier, date, rows.length, csv));
  }

  const nowIso = new Date().toISOString();
  const upd = db.prepare("UPDATE orders SET status = 'sent_to_carrier', ship_date = ?, sent_to_carrier_at = ? WHERE id = ? AND status = 'paid'");
  tx(() => orders.forEach((o) => upd.run(date, nowIso, o.id)));

  const packing = mails.packingListMail(date, shipments, stockAlerts());
  packing.attachments = csvs.map(({ carrier, csv }) => ({ filename: `${carrier}-${date}.csv`, content: csv }));
  await sendMail(packing);
  return { orders: orders.length, boxes: shipments.reduce((n, s) => n + s.boxes.length, 0) };
}

/** 発送日の夕方：集荷済みとして「発送しました」メール */
export async function markShipped(date) {
  const db = getDb();
  const orders = db.prepare("SELECT * FROM orders WHERE status = 'sent_to_carrier' AND ship_date <= ? ORDER BY id").all(date);
  for (const order of orders) {
    db.prepare("UPDATE orders SET status = 'shipped', shipped_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
    await sendMail(mails.shippedMail(order, getBoxes(order.id)));
  }
  return { orders: orders.length };
}

/** 業者から返ってきた伝票番号を取り込む。発送済みの注文にはお問い合わせ番号を通知。 */
export async function importTracking(text) {
  const db = getDb();
  const touched = new Set();
  let updated = 0;
  for (const { key, trackingNo } of parseTrackingText(text)) {
    const [, ymd, id, boxNo] = key.match(/^SHO-(\d{8})-(\d+)-(\d+)$/);
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(`SHO-${ymd}-${id}`);
    if (!order) continue;
    const r = db.prepare('UPDATE boxes SET tracking_no = ? WHERE order_id = ? AND box_no = ? AND (tracking_no IS NULL OR tracking_no != ?)')
      .run(trackingNo, order.id, Number(boxNo), trackingNo);
    if (r.changes) {
      updated++;
      touched.add(order.id);
    }
  }
  for (const id of touched) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (order.status === 'shipped') await sendMail(mails.trackingMail(order, getBoxes(id)));
  }
  return { updated };
}

export function ordersForAdmin() {
  const db = getDb();
  return db.prepare("SELECT * FROM orders WHERE status != 'canceled' ORDER BY (status = 'shipped'), ship_date, id DESC LIMIT 200").all()
    .map((o) => ({ ...o, items: JSON.parse(o.items_json), boxes: getBoxes(o.id).map((b) => ({ ...b, contents: JSON.parse(b.contents_json) })) }));
}

export function setBoxPacked(boxId, packed) {
  getDb().prepare('UPDATE boxes SET packed = ? WHERE id = ?').run(packed ? 1 : 0, boxId);
}

export function setCarrier(orderId, carrier) {
  if (!config.shipping.carriers[carrier]) throw new UserError('不明な配送業者');
  getDb().prepare("UPDATE orders SET carrier = ? WHERE id = ? AND status IN ('awaiting_payment', 'paid')").run(carrier, orderId);
}

export function setStock(productId, quantity) {
  if (!productById(productId) || !Number.isInteger(quantity) || quantity < 0) throw new UserError('在庫数が不正です');
  getDb().prepare('UPDATE stock SET quantity = ? WHERE product_id = ?').run(quantity, productId);
}
