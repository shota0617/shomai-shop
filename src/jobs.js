// 毎日の自動処理。定期的に呼ばれて日本時間を見て、営業日の決まった時刻を過ぎていたら、その日1回だけ実行する。
// 呼び出し元：Cloudflare は Cron Trigger（5分ごと）、Node.js は1分ごとのタイマー。
// 止まっていて時刻を過ぎた場合も、その日のうちに動けば実行される。
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
  const db = await getDb();
  for (const job of JOBS) {
    if (time < job.at()) continue;
    const key = `${job.name}:${date}`;
    const { changes: claimed } = await db.run('INSERT OR IGNORE INTO job_runs (key, ran_at) VALUES (?, ?)', key, now.toISOString());
    if (!claimed) continue;
    try {
      const result = await job.run(date);
      console.log(`[job] ${key}`, result);
    } catch (e) {
      // 失敗したら次の回で再実行できるように記録を消す
      await db.run('DELETE FROM job_runs WHERE key = ?', key);
      console.error(`[job] ${key} 失敗`, e);
    }
  }
}
