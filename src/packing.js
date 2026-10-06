// 注文商品を箱に振り分ける（重い順に詰める first-fit decreasing）。
// 店主に見せる「この箱にこれを入れる」リストと、送料計算の箱数の両方に使う。

/**
 * @param {{productId:string,name:string,weightKg:number,quantity:number}[]} items
 * @param {number} maxBoxKg
 * @returns {{weightKg:number, contents:{productId:string,name:string,quantity:number}[]}[]}
 */
export function packBoxes(items, maxBoxKg) {
  const units = [];
  for (const it of items) {
    for (let i = 0; i < it.quantity; i++) units.push(it);
  }
  units.sort((a, b) => b.weightKg - a.weightKg);

  const boxes = [];
  for (const u of units) {
    // 上限より重い商品は単独で1箱
    let box = boxes.find((b) => b.weightKg + u.weightKg <= maxBoxKg);
    if (!box) {
      box = { weightKg: 0, contents: [] };
      boxes.push(box);
    }
    box.weightKg += u.weightKg;
    const line = box.contents.find((c) => c.productId === u.productId);
    if (line) line.quantity += 1;
    else box.contents.push({ productId: u.productId, name: u.name, quantity: 1 });
  }
  return boxes;
}

/** 宅急便／ゆうパックの目安サイズ（米袋の重量から推定） */
export function boxSizeFor(weightKg) {
  if (weightKg <= 2) return 60;
  if (weightKg <= 5) return 80;
  if (weightKg <= 10) return 100;
  if (weightKg <= 15) return 120;
  return 140;
}

export function shippingFee(subtotal, boxCount, { feePerBox, freeShippingFrom }) {
  if (freeShippingFrom > 0 && subtotal >= freeShippingFrom) return 0;
  return feePerBox * boxCount;
}
