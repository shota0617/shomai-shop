# 翔米 全自動ECサイト

店主の仕事は **「届いたメールを見て、お米を箱に入れ、業者が持ってきた送り状を貼って渡す」だけ** にするためのネットショップです。

## 自動で回る流れ

| いつ | システムが自動でやること | 店主 |
|---|---|---|
| お客様が注文 | 金額・送料・箱数を計算し、Stripe の決済画面（カード／コンビニ払い）へ | — |
| 入金確認 | 注文を登録、在庫を引き当て、発送日を決定、お客様へ確認メール | — |
| 発送日の締め時刻（既定 12:00） | 当日分の **送り状データ（CSV）と集荷依頼** をヤマト運輸／日本郵便の担当窓口へメール。店主へ「本日の箱詰めリスト」をメール | — |
| 集荷まで | — | **リストどおり箱に入れる** |
| 集荷時 | — | **業者が持参した送り状を貼って渡す** |
| 業者から伝票番号が届いたら | 管理画面に貼り付けるだけで取り込み、お客様へお問い合わせ番号をメール | 貼り付け（任意） |
| 発送日の夕方（既定 18:00） | お客様へ「発送しました」メール（伝票番号があれば追跡リンク付き） | — |

ほかにも次のことを自動で行います。

- 定休日・臨時休業日は飛ばして発送日を決めます。
- 1箱の上限重量（既定 20kg）で自動的に箱を分けます。送料は箱数で計算します。
- 在庫が 5 以下になると、箱詰めリストのメールでお知らせします。
- コンビニ払いは入金されるまで発送しません。期限切れの注文は自動でキャンセルします。

## まず動かしてみる（デモモード）

Node.js 22.13 以上が必要です。

```sh
cd shomai
npm install
npm start
```

- ショップ：http://localhost:3000
- 管理画面：http://localhost:3000/admin

Stripe を設定していないあいだは **デモモード** で動きます。決済画面は擬似的なもので、メールは送らずに `data/outbox/` に保存します。

テストは `npm test` で実行します。

## 本番公開の手順（Cloudflare）

翔米は Cloudflare Workers で動きます。ポイントシステムと同じ Cloudflare アカウントの中で、**別の Worker・別のデータベース・別のドメイン** として置きます。
費用は、小さなお店の注文数なら無料プランの範囲に収まります。

1. **データベースを作る**
   - Cloudflare ダッシュボード →「ストレージとデータベース」→「D1」→「作成」で、名前を `shomai-shop` にします。
   - 表示された **Database ID** を `wrangler.jsonc` の `database_id` に書きます。
   - 表は最初のアクセス時に自動で作られます。
2. **Worker を作る**
   - 「Workers & Pages」→「作成」→「リポジトリをインポート」で、GitHub の `shomai-shop` を選びます。
   - デプロイコマンドは `npx wrangler deploy` のままにします。
   - 以後は GitHub の `main` が更新されるたびに、自動で反映されます。
3. **設定値を登録する**：Worker の「設定」→「変数とシークレット」に、`.env.example` にある項目を登録します。
   - **必須**：`BASE_URL`（例：`https://shop.ricepia.jp`）、`ADMIN_PASSWORD`
   - **秘密の値**：`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`RESEND_API_KEY` は種類を「シークレット」にします。
   - **店の情報**：送り状の差出人（`SENDER_*`）、特定商取引法の表記（`LEGAL_*`）、`OWNER_EMAIL` なども登録します。
4. **ドメインを付ける**：Worker の「設定」→「ドメインとルート」→「カスタムドメイン」で、`shop.〜` のような **翔米専用のサブドメイン** を付けます。ポイントシステムのドメインとは別にしてください。
5. **Stripe**：既存のアカウント（らいすぴあ）で、カードとコンビニ払いを有効にします。
   - Webhook の送信先を `https://（翔米のドメイン）/webhooks/stripe` にします。
   - 受け取るイベントは `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired` の4つです。
   - 表示される署名シークレットを `STRIPE_WEBHOOK_SECRET` に登録します。
6. **メール**：[Resend](https://resend.com) で送信元ドメインを認証し、`RESEND_API_KEY` を登録します。
   - 未登録のあいだはメールを送らず、Worker のログに内容を出すだけです。
7. **配送業者との取り決め**（ここだけは人がやります）
   - ヤマト運輸の担当営業所、または日本郵便の担当郵便局に、次の運用をお願いしてください。
     - 「毎日 締め時刻に送り状データ（CSV・Shift_JIS）をメールで送るので、送り状を印字して集荷時に持ってきてほしい」
     - 「伝票番号が分かるデータを返信してほしい」
   - 担当窓口のメールアドレスを `YAMATO_EMAIL` / `JAPANPOST_EMAIL` に、契約のお客様コードを `*_CUSTOMER_CODE` に登録します。
   - 定期集荷にしておくと、集荷依頼の電話も要りません。
   - CSV の列は、B2クラウド／ゆうパック送り状の主要項目に見出しを付けたものです。業者側で取込レイアウトの設定が必要か、初回に確認してください。列は `src/carriers.js` で変えられます。

締め時刻・夕方の自動処理は、Cloudflare の Cron Trigger が5分ごとに確認して実行します。

### Cloudflare 以外で動かす場合

Node.js だけでも動きます（データは SQLite のファイル1つ）。`.env.example` を `.env` にコピーして記入し、`npm start` で起動します。

- Docker：`docker build -t shomai . && docker run -p 3000:3000 --env-file .env -v shomai-data:/data shomai`
- `DATA_DIR` は **永続ディスク** にしてください。

## らいすぴあポイントシステムとの共存

翔米ショップは、ポイントシステム（`raispia-points`）とは **完全に別のシステム** です。

- コード・データベース・サーバーは共有しません。LINE（LIFF・公式アカウント）も一切使いません。
- Cloudflare では、Worker（`shomai-shop`）・D1 データベース（`shomai-shop`）・ドメイン（`shop.〜`）をすべて翔米専用にします。
  - ポイントシステムの Worker・データベース・設定には一切触れません。共有するのは Cloudflare のアカウントだけです。
- **Stripe**：ポイントシステムは Stripe を使っていないため、既存の Stripe アカウント（らいすぴあ）をそのまま使います。
  - 翔米は自分で作った決済に `metadata.shop = "shomai"` を付け、Webhook ではその印がある決済だけを扱います。
  - 同じアカウントで別の決済（店頭のリンク決済など）があっても、翔米の注文として扱われることはありません。
  - Webhook の送信先は、翔米用に **新しく追加** します。既存の送信先があれば、それは変更しないでください。

## 商品・価格の変更

`src/config.js` の `products` を編集します。いまの価格は **仮の値** です。

在庫数は管理画面から変更できます。

## ファイル構成

```
src/worker.js    Cloudflare Workers の入口（画面配信・Cron）
src/node.js      Node.js の入口（手元での確認・テスト・Docker）
src/app.js       画面・API・Stripe Webhook
src/db.js        データベース（Cloudflare は D1、Node.js は SQLite）
src/orders.js    注文の流れ（見積り→入金→業者送信→発送通知）
src/jobs.js      毎日の自動処理（締め時刻・夕方）
src/carriers.js  ヤマト／日本郵便向けCSV、伝票番号の読み取り
src/packing.js   箱詰め・送料
src/calendar.js  営業日・発送日（日本時間）
src/emails.js    メール文面
src/admin.js     店主用管理画面
public/          お客様向けショップ画面
wrangler.jsonc   Cloudflare の設定
```
