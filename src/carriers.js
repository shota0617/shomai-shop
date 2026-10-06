// 配送業者向けの送り状データ（CSV）生成。
// 運用：締め時刻に当日分のCSVを業者の担当窓口へメール → 業者が送り状を印字して集荷時に持参。
// 1行 = 1箱 = 送り状1枚。お客様管理番号（SHO-YYYYMMDD-NNNN-箱番号）で伝票番号と突き合わせる。
import iconv from 'iconv-lite';
import { config } from './config.js';

// B2クラウドの配達時間帯コード
const YAMATO_TIME = { 午前中: '0812', '14-16時': '1416', '16-18時': '1618', '18-20時': '1820', '19-21時': '1921' };
// ゆうパックは記号コードが取込設定によって異なるため、人が読める表記で渡す
const JAPANPOST_TIME = { 午前中: '午前中', '14-16時': '14時～16時', '16-18時': '16時～18時', '18-20時': '18時～20時', '19-21時': '19時～21時' };

const slash = (ymd) => ymd.replaceAll('-', '/');

function yamatoRows(shipments) {
  const c = config.shipping.carriers.yamato;
  const s = config.shop.sender;
  const header = [
    'お客様管理番号', '送り状種類', 'クール区分', '伝票番号', '出荷予定日', 'お届け予定日', '配達時間帯',
    'お届け先電話番号', 'お届け先郵便番号', 'お届け先住所', 'お届け先アパートマンション名', 'お届け先名', '敬称',
    'ご依頼主電話番号', 'ご依頼主郵便番号', 'ご依頼主住所', 'ご依頼主名', 'ご依頼主名(ｶﾅ)',
    '品名１', '荷扱い１', '記事', '請求先顧客コード', '運賃管理番号',
  ];
  const rows = shipments.map(({ order, box, boxCount }) => [
    box.key, '0', '0', '', slash(order.ship_date), '', YAMATO_TIME[order.time_slot] ?? '',
    order.phone, order.zip, order.address1, order.address2, order.name, '様',
    s.tel, s.zip, s.address, s.name, s.nameKana,
    `お米（${box.weight_kg}kg）`, '下積厳禁', `${box.box_no}/${boxCount}個口`, c.customerCode, c.freightCode,
  ]);
  return [header, ...rows];
}

function japanpostRows(shipments) {
  const s = config.shop.sender;
  const header = [
    'お客様側管理番号', '発送予定日', 'お届け先郵便番号', 'お届け先住所1', 'お届け先住所2', 'お届け先名称', '敬称',
    'お届け先電話番号', 'ご依頼主郵便番号', 'ご依頼主住所', 'ご依頼主名称', 'ご依頼主電話番号',
    '品名', '重量(kg)', 'サイズ', '配達希望時間帯', '記事', 'お客様コード',
  ];
  const rows = shipments.map(({ order, box, boxCount }) => [
    box.key, slash(order.ship_date), order.zip, order.address1, order.address2, order.name, '様',
    order.phone, s.zip, s.address, s.name, s.tel,
    'お米', box.weight_kg, box.size, JAPANPOST_TIME[order.time_slot] ?? '', `${box.box_no}/${boxCount}個口`,
    config.shipping.carriers.japanpost.customerCode,
  ]);
  return [header, ...rows];
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * @param {'yamato'|'japanpost'} carrier
 * @param {{order:object, box:object, boxCount:number}[]} shipments
 * @returns {Buffer} Shift_JIS の CSV（業者の送り状システムが標準で読める文字コード）
 */
export function buildCarrierCsv(carrier, shipments) {
  const rows = carrier === 'japanpost' ? japanpostRows(shipments) : yamatoRows(shipments);
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return iconv.encode(text, 'Shift_JIS');
}

export function trackingUrl(carrier, trackingNo) {
  const c = config.shipping.carriers[carrier];
  return c && trackingNo ? `${c.trackingUrl}${encodeURIComponent(trackingNo.replaceAll('-', ''))}` : '';
}

/**
 * 業者から返ってきたデータ（CSV・メール本文の貼り付け等、形式は問わない）から
 * 「お客様管理番号 → 伝票番号」の組を取り出す。
 */
export function parseTrackingText(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const key = line.match(/SHO-\d{8}-\d{4,}-\d+/)?.[0];
    if (!key) continue;
    const rest = line.replace(key, '');
    // ヤマト・ゆうパックとも伝票番号は12桁（電話番号は10〜11桁なので誤認しない）
    const no = rest.match(/(?<![\d-])\d{4}-?\d{4}-?\d{4}(?![\d-])/)?.[0];
    if (no) result.push({ key, trackingNo: no.replaceAll('-', '') });
  }
  return result;
}
