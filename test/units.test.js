import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { shipDateFor, jstParts } from '../src/calendar.js';
import { packBoxes, shippingFee, boxSizeFor } from '../src/packing.js';
import { verifyWebhook, encodeForm } from '../src/stripe.js';
import { buildCarrierCsv, parseTrackingText } from '../src/carriers.js';
import { fromStripeSession } from '../src/orders.js';

const rules = { cutoff: '12:00', closedWeekdays: [0], holidays: ['2026-10-12'] };
const jst = (s) => new Date(`${s}+09:00`);

test('締め時刻前の入金は当日発送、以降は翌営業日', () => {
  assert.equal(shipDateFor(jst('2026-10-06T11:59'), rules), '2026-10-06');
  assert.equal(shipDateFor(jst('2026-10-06T12:00'), rules), '2026-10-07');
});

test('定休日（日曜）と休業日は飛ばす', () => {
  assert.equal(shipDateFor(jst('2026-10-10T13:00'), rules), '2026-10-13'); // 土曜午後→日曜休→月曜祝日休→火曜
  assert.equal(shipDateFor(jst('2026-10-11T09:00'), rules), '2026-10-13');
});

test('JST変換はサーバーのタイムゾーンに依存しない', () => {
  assert.deepEqual(jstParts(new Date('2026-10-06T15:30:00Z')), { date: '2026-10-07', time: '00:30', weekday: 3 });
});

test('箱詰め：重い順に上限重量まで詰める', () => {
  const items = [
    { productId: 'a', name: '10kg', weightKg: 10, quantity: 3 },
    { productId: 'b', name: '2kg', weightKg: 2, quantity: 2 },
  ];
  const boxes = packBoxes(items, 20);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((b) => b.weightKg), [20, 14]);
  assert.deepEqual(boxes[1].contents, [{ productId: 'a', name: '10kg', quantity: 1 }, { productId: 'b', name: '2kg', quantity: 2 }]);
  assert.equal(boxSizeFor(14), 120);
});

test('送料：箱数 × 1箱料金、一定額以上で無料', () => {
  assert.equal(shippingFee(5000, 2, { feePerBox: 990, freeShippingFrom: 10000 }), 1980);
  assert.equal(shippingFee(10000, 2, { feePerBox: 990, freeShippingFrom: 10000 }), 0);
  assert.equal(shippingFee(99999, 1, { feePerBox: 990, freeShippingFrom: 0 }), 990);
});

test('Stripe署名：正しい署名だけ受け付ける', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const t = 1_700_000_000;
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyWebhook(body, `t=${t},v1=${sig}`, secret, 300, t).type, 'checkout.session.completed');
  assert.throws(() => verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)}`, secret, 300, t), /一致しません/);
  assert.throws(() => verifyWebhook(body + ' ', `t=${t},v1=${sig}`, secret, 300, t), /一致しません/);
  assert.throws(() => verifyWebhook(body, `t=${t},v1=${sig}`, secret, 300, t + 301), /期限切れ/);
});

test('Stripeのform形式エンコード', () => {
  const f = encodeForm({ a: [{ b: { c: 1 } }, { b: { c: 2 } }], d: ['x', 'y'], e: undefined });
  assert.equal(decodeURIComponent(f.toString()), 'a[0][b][c]=1&a[1][b][c]=2&d[0]=x&d[1]=y');
});

test('Checkout Session からお届け先を取り出す', () => {
  const c = fromStripeSession({
    id: 'cs_1', payment_status: 'paid',
    customer_details: { email: 'a@example.com', name: 'カード 名義', phone: '+819012345678' },
    shipping_details: { name: '山田 太郎', address: { postal_code: '4600001', state: '愛知県', city: '名古屋市中区', line1: '三の丸1-1', line2: '101号' } },
    custom_fields: [{ key: 'timeslot', dropdown: { value: 'am' } }],
  });
  assert.equal(c.name, '山田 太郎');
  assert.equal(c.address1, '愛知県名古屋市中区三の丸1-1');
  assert.equal(c.address2, '101号');
  assert.equal(c.timeSlot, '午前中');
  assert.equal(c.paid, true);
});

const shipment = (boxNo, boxCount, slot = '午前中') => ({
  order: { ship_date: '2026-10-06', time_slot: slot, phone: '090-1234-5678', zip: '460-0001', address1: '愛知県名古屋市中区三の丸1-1', address2: '"A"棟, 101', name: '山田 太郎' },
  box: { key: `SHO-20261006-0001-${boxNo}`, box_no: boxNo, weight_kg: 10, size: 100 },
  boxCount,
});

test('ヤマト用CSV：Shift_JIS・時間帯コード・CSVエスケープ', () => {
  const text = iconv.decode(buildCarrierCsv('yamato', [shipment(1, 2), shipment(2, 2, '指定なし')]), 'Shift_JIS');
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^お客様管理番号,送り状種類/);
  assert.match(lines[1], /^SHO-20261006-0001-1,0,0,,2026\/10\/06,,0812,090-1234-5678,460-0001,/);
  assert.match(lines[1], /"""A""棟, 101"/);
  assert.match(lines[1], /1\/2個口/);
  assert.match(lines[2], /,2026\/10\/06,,,090/); // 指定なし→空欄
});

test('ゆうパック用CSV', () => {
  const text = iconv.decode(buildCarrierCsv('japanpost', [shipment(1, 1, '19-21時')]), 'Shift_JIS');
  assert.match(text, /^お客様側管理番号,発送予定日/);
  assert.match(text, /19時～21時/);
});

test('業者から返ってきたデータから伝票番号を読み取る（電話番号は無視）', () => {
  const text = [
    'お客様管理番号,伝票番号,電話',
    'SHO-20261006-0001-1,4123-4567-8901,090-1234-5678',
    '"09012345678","SHO-20261006-0001-2","412345678902"',
    'SHO-20261006-0002-1 電話 09012345678 のみ',
  ].join('\n');
  assert.deepEqual(parseTrackingText(text), [
    { key: 'SHO-20261006-0001-1', trackingNo: '412345678901' },
    { key: 'SHO-20261006-0001-2', trackingNo: '412345678902' },
  ]);
});
