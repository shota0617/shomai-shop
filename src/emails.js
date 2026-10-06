// メール文面
import { config } from './config.js';
import { trackingUrl } from './carriers.js';

const yen = (n) => `${n.toLocaleString('ja-JP')}円`;
const shop = () => config.shop.name;
const footer = () => `\n――――――――――――\n${shop()}（${config.shop.legal.販売業者}）\n${config.baseUrl}\n`;

function itemLines(order) {
  return JSON.parse(order.items_json).map((i) => `・${i.name} × ${i.quantity}　${yen(i.price * i.quantity)}`).join('\n');
}

function summary(order) {
  return [
    `ご注文番号：${order.order_no}`,
    '',
    itemLines(order),
    `送料：${yen(order.shipping_fee)}`,
    `合計：${yen(order.total)}（税込）`,
    '',
    'お届け先：',
    `〒${order.zip} ${order.address1} ${order.address2}`.trim(),
    `${order.name} 様（${order.phone}）`,
    `配達時間帯：${order.time_slot}`,
  ].join('\n');
}

export function awaitingPaymentMail(order) {
  return {
    to: order.email,
    subject: `【${shop()}】ご注文を受け付けました（お支払い待ち）`,
    text: `${order.name} 様\n\nご注文ありがとうございます。\nお支払いの確認後、発送準備に入ります。コンビニ払いの払込票はStripeから別途メールでお届けしています。\n\n${summary(order)}\n${footer()}`,
  };
}

export function orderConfirmedMail(order) {
  return {
    to: order.email,
    subject: `【${shop()}】ご注文ありがとうございます（${order.order_no}）`,
    text: `${order.name} 様\n\nお支払いを確認しました。\n${order.ship_date.replaceAll('-', '/')} に精米・発送予定です。発送しましたら改めてご連絡します。\n\n${summary(order)}\n${footer()}`,
  };
}

export function shippedMail(order, boxes) {
  const carrier = config.shipping.carriers[order.carrier];
  const tracking = boxes
    .map((b) => (b.tracking_no ? `・${b.box_no}箱目：${b.tracking_no}\n  ${trackingUrl(order.carrier, b.tracking_no)}` : null))
    .filter(Boolean);
  const trackingText = tracking.length
    ? `お問い合わせ番号：\n${tracking.join('\n')}`
    : 'お問い合わせ番号は、確定しだい別途お知らせします。';
  return {
    to: order.email,
    subject: `【${shop()}】発送しました（${order.order_no}）`,
    text: `${order.name} 様\n\n本日、${carrier.name}にてお米を発送しました（${boxes.length}箱）。\n${trackingText}\n\n${summary(order)}\n${footer()}`,
  };
}

export function trackingMail(order, boxes) {
  return {
    to: order.email,
    subject: `【${shop()}】お問い合わせ番号のお知らせ（${order.order_no}）`,
    text: `${order.name} 様\n\n発送済みのお荷物のお問い合わせ番号をお知らせします。\n\n${boxes
      .filter((b) => b.tracking_no)
      .map((b) => `・${b.box_no}箱目：${b.tracking_no}\n  ${trackingUrl(order.carrier, b.tracking_no)}`)
      .join('\n')}\n${footer()}`,
  };
}

export function carrierRequestMail(carrier, date, boxCount, csv) {
  const c = config.shipping.carriers[carrier];
  const s = config.shop.sender;
  return {
    to: c.email || config.mail.ownerTo,
    subject: `【集荷依頼・送り状データ】${s.name} ${date.replaceAll('-', '/')} ${boxCount}個口`,
    text: [
      c.email ? `${c.name} ご担当者様` : `※ ${c.name}の窓口メール（.env の ${carrier === 'yamato' ? 'YAMATO_EMAIL' : 'JAPANPOST_EMAIL'}）が未設定のため、店主宛てに送っています。業者へ転送してください。`,
      '',
      'いつもお世話になっております。',
      `本日 ${date.replaceAll('-', '/')} の集荷をお願いいたします。`,
      `個数：${boxCount}個口（お米）`,
      '送り状データ（CSV）を添付しますので、印字した送り状を集荷時にお持ちください。',
      '発行後、伝票番号入りのデータをこのメールへご返信いただけますと幸いです。',
      '',
      `${s.name}`,
      `〒${s.zip} ${s.address}`,
      `TEL ${s.tel}`,
      c.customerCode ? `お客様コード ${c.customerCode}` : '',
    ].join('\n'),
    attachments: [{ filename: `${carrier}-${date}.csv`, content: csv }],
  };
}

export function packingListMail(date, shipments, stockAlerts) {
  const blocks = shipments.map(({ order, boxes }) => {
    const boxLines = boxes
      .map((b) => `  [${b.box_no}/${boxes.length}箱目・${b.size}サイズ] ${JSON.parse(b.contents_json).map((c) => `${c.name}×${c.quantity}`).join('、')}`)
      .join('\n');
    return `■ ${order.order_no}　${order.name} 様（${config.shipping.carriers[order.carrier].name}）\n${boxLines}`;
  });
  const totalBoxes = shipments.reduce((n, s) => n + s.boxes.length, 0);
  return {
    to: config.mail.ownerTo,
    subject: `【${shop()}】本日の発送 ${totalBoxes}箱（${date.replaceAll('-', '/')}）`,
    text: [
      `本日の発送は ${shipments.length}件・${totalBoxes}箱です。`,
      '送り状は集荷時に業者が持参します。下の内容で箱詰めして、送り状を貼って渡すだけでOKです。',
      '',
      ...blocks,
      '',
      stockAlerts.length ? `⚠ 在庫が少なくなっています：\n${stockAlerts.join('\n')}\n` : '',
      `管理画面：${config.baseUrl}/admin`,
    ].join('\n'),
  };
}
