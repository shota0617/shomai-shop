// Cloudflare Workers の入口。
// 商品ページなど public/ のファイルは Cloudflare が直接返し、それ以外（API・管理画面・Webhook）がここに来る。
// 締め時刻・夕方の自動処理は Cron Trigger（wrangler.jsonc の triggers）から呼ばれる。
import { initConfig, isDemo, config } from './config.js';
import { setDb, d1Adapter } from './db.js';
import { tick } from './jobs.js';
import { handle } from './app.js';

let boundD1;

function setup(env, request) {
  // BASE_URL 未登録でも、アクセスされたアドレスで動くようにする
  initConfig(request ? { BASE_URL: new URL(request.url).origin, ...env } : env);
  // 同じ D1 なら使い回す（表の作成確認を毎回しないため）
  if (boundD1 !== env.DB) {
    boundD1 = env.DB;
    setDb(d1Adapter(env.DB));
  }
}

export default {
  async fetch(request, env) {
    setup(env, request);
    if (!isDemo() && !config.stripe.webhookSecret) return new Response('STRIPE_WEBHOOK_SECRET を設定してください', { status: 503 });
    return handle(request);
  },

  async scheduled(event, env, ctx) {
    setup(env);
    ctx.waitUntil(tick(new Date(event.scheduledTime)));
  },
};
