// 毎日の自動処理。1分ごとに日本時間を見て、営業日の決まった時刻に1回だけ実行する。
// サーバーが止まっていて時刻を過ぎた場合も、その日のうちに起動すれば実行される。
import { config } from './config.js';
import { getDb } from './db.js';
import { jstParts, isBusinessDay } from './calendar.js';
import { dispatchBatch, markShipped } from './orders.js';

const JOBS = [
  { name: 'dispatch', at: () => config.shipping.cutoff, run: dispatchBatch },
  { name: 'shipped', at: () => config.shipping.shippedNoticeAt, run: markShipped },
];

export async function tick(now = new Date()) {
  const { date, time } = jstParts(now);
  if (!isBusinessDay(date, config.shipping)) return;
  const db = getDb();
  for (const job of JOBS) {
    if (time < job.at()) continue;
    const key = `${job.name}:${date}`;
    const claimed = db.prepare('INSERT OR IGNORE INTO job_runs (key, ran_at) VALUES (?, ?)').run(key, now.toISOString()).changes;
    if (!claimed) continue;
    try {
      const result = await job.run(date);
      console.log(`[job] ${key}`, result);
    } catch (e) {
      // 失敗したら次の tick で再実行できるように記録を消す
      db.prepare('DELETE FROM job_runs WHERE key = ?').run(key);
      console.error(`[job] ${key} 失敗`, e);
    }
  }
}

export function startScheduler() {
  const loop = () => tick().catch((e) => console.error('[job] tick 失敗', e));
  loop();
  return setInterval(loop, 60 * 1000);
}
