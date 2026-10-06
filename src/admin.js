// 店主用の管理画面（スマホで見る前提）。サーバー側でHTMLを組み立てる。
import { config } from './config.js';
import { jstParts } from './calendar.js';
import { trackingUrl } from './carriers.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = {
  awaiting_payment: ['入金待ち', '#9a9a7a'],
  paid: ['発送待ち', '#c8a96e'],
  sent_to_carrier: ['送り状手配済・本日集荷', '#d4924a'],
  shipped: ['発送済み', '#5b8a6b'],
};

function orderCard(o) {
  const [label, color] = STATUS[o.status] ?? [o.status, '#999'];
  const carrierSelect = ['awaiting_payment', 'paid'].includes(o.status)
    ? `<select onchange="post('/admin/api/carrier',{orderId:${o.id},carrier:this.value})">${Object.entries(config.shipping.carriers)
      .map(([k, c]) => `<option value="${k}"${k === o.carrier ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
    : esc(config.shipping.carriers[o.carrier]?.name);
  const boxes = o.boxes.map((b) => `
    <label class="box${b.packed ? ' done' : ''}">
      <input type="checkbox" ${b.packed ? 'checked' : ''} onchange="this.parentElement.classList.toggle('done',this.checked);post('/admin/api/packed',{boxId:${b.id},packed:this.checked})">
      <span><b>${b.box_no}/${o.boxes.length}箱目</b>（${b.size}サイズ・${b.weight_kg}kg）<br>
      ${b.contents.map((c) => `${esc(c.name)} × ${c.quantity}`).join('<br>')}
      ${b.tracking_no ? `<br><a href="${esc(trackingUrl(o.carrier, b.tracking_no))}" target="_blank">伝票 ${esc(b.tracking_no)}</a>` : ''}</span>
    </label>`).join('');
  return `
  <div class="card">
    <div class="row"><span class="badge" style="background:${color}">${label}</span><span class="muted">${esc(o.order_no)}</span></div>
    <div class="name">${esc(o.name)} 様</div>
    <div class="muted">〒${esc(o.zip)} ${esc(o.address1)} ${esc(o.address2)}<br>${esc(o.phone)}・時間帯：${esc(o.time_slot)}</div>
    <div class="muted">発送日：${esc(o.ship_date ?? '入金後に決定')}・配送：${carrierSelect}・合計 ${o.total.toLocaleString()}円</div>
    ${boxes}
  </div>`;
}

export function renderAdmin({ orders, products }) {
  const today = jstParts().date;
  const todo = orders.filter((o) => ['paid', 'sent_to_carrier'].includes(o.status) && o.ship_date <= today);
  const later = orders.filter((o) => !todo.includes(o) && o.status !== 'shipped');
  const done = orders.filter((o) => o.status === 'shipped').slice(0, 30);
  const totalBoxes = todo.reduce((n, o) => n + o.boxes.length, 0);

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>翔米 管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hiragino Sans','Noto Sans JP',sans-serif;background:#f5f2eb;color:#2d2d1e;padding:0 16px 60px}
header{background:#2d2d1e;color:#f5f2eb;margin:0 -16px 16px;padding:14px 16px;font-weight:700;letter-spacing:.08em}
header small{color:#c8a96e;font-weight:400;margin-left:8px}
main{max-width:560px;margin:0 auto}
h2{font-size:14px;margin:22px 0 8px;color:#5a5a4a}
.hero{background:#fff;border:1px solid #e8e4d8;border-radius:14px;padding:18px;text-align:center}
.hero b{font-size:40px;color:#c8a96e;display:block}
.card{background:#fff;border:1px solid #e8e4d8;border-radius:14px;padding:14px;margin-bottom:10px;font-size:13px;line-height:1.6}
.row{display:flex;justify-content:space-between;align-items:center}
.badge{color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}
.name{font-size:16px;font-weight:700;margin-top:4px}
.muted{color:#6a6a54;font-size:12px}
.box{display:flex;gap:10px;align-items:flex-start;border:1.5px dashed #c4bfaa;border-radius:10px;padding:10px;margin-top:8px}
.box.done{border-style:solid;border-color:#5b8a6b;background:#eef5f0}
.box input{width:22px;height:22px;flex-shrink:0;accent-color:#5b8a6b}
textarea,input[type=number],select{font:inherit;border:1.5px solid #c4bfaa;border-radius:8px;padding:6px;background:#fafaf7}
textarea{width:100%;min-height:90px}
button{font:inherit;background:#2d2d1e;color:#c8a96e;border:none;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer}
table{width:100%;font-size:13px}td{padding:4px 0}
a{color:#4a7ab5}
</style></head><body>
<header>翔米<small>店主用 管理画面</small></header>
<main>
<div class="hero">本日（${today}）箱詰めする数<b>${totalBoxes}箱</b>
<span class="muted">送り状は締め時刻（${esc(config.shipping.cutoff)}）に業者へ自動送信済み／予定。集荷時に業者が持参します。</span></div>

<h2>📦 本日の発送</h2>
${todo.map(orderCard).join('') || '<p class="muted">本日の発送はありません</p>'}

<h2>⏳ これから（入金待ち・明日以降）</h2>
${later.map(orderCard).join('') || '<p class="muted">ありません</p>'}

<h2>🔢 伝票番号の取り込み</h2>
<div class="card">業者から返ってきたデータ（CSVやメール本文）をそのまま貼り付けてください。お客様管理番号（SHO-…）と伝票番号を自動で読み取り、発送済みのお客様には番号をメールします。
<textarea id="tracking" placeholder="SHO-20261006-0001-1,123456789012"></textarea>
<button onclick="post('/admin/api/tracking',{text:document.getElementById('tracking').value})">取り込む</button></div>

<h2>🌾 在庫</h2>
<div class="card"><table>${products.map((p) => `<tr><td>${esc(p.name)}</td><td style="text-align:right">
<input type="number" min="0" value="${p.stock}" style="width:80px" onchange="post('/admin/api/stock',{productId:'${esc(p.id)}',quantity:Number(this.value)})"></td></tr>`).join('')}</table></div>

<h2>✅ 発送済み（直近30件）</h2>
${done.map(orderCard).join('') || '<p class="muted">まだありません</p>'}
</main>
<script>
async function post(url, body){
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'shomai'},body:JSON.stringify(body)});
  const j = await r.json().catch(()=>({}));
  if(!r.ok){alert(j.error||'エラーが発生しました');return;}
  if(j.message) alert(j.message);
  if(j.reload) location.reload();
}
</script></body></html>`;
}
