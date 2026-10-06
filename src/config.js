// 翔米ショップの設定。秘密情報は .env（環境変数）で、店の情報・商品はここで管理する。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile) && !process.env.SHOMAI_SKIP_DOTENV) process.loadEnvFile(envFile);

const env = (key, fallback = '') => process.env[key] ?? fallback;
const list = (key, fallback = '') => env(key, fallback).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env('PORT', '3000')),
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),

  // 決済（Stripe）。未設定ならデモモード（擬似決済）で動く。
  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    // card / konbini（コンビニ払い）など。Stripeダッシュボードで有効化したものを並べる。
    paymentMethods: list('STRIPE_PAYMENT_METHODS', 'card,konbini'),
  },

  // メール送信（Resend）。未設定なら data/outbox/ に .eml として保存するだけ。
  mail: {
    resendApiKey: env('RESEND_API_KEY'),
    from: env('MAIL_FROM', '翔米 <shop@example.com>'),
    ownerTo: env('OWNER_EMAIL', 'owner@example.com'),
  },

  admin: {
    user: env('ADMIN_USER', 'admin'),
    password: env('ADMIN_PASSWORD', ''),
  },

  // 配送。送り状は配送業者が印字して集荷時に持参する運用。
  // システムは締め時刻に「送り状データCSV」を各業者の窓口メールへ自動送信する。
  shipping: {
    defaultCarrier: env('DEFAULT_CARRIER', 'yamato'), // yamato | japanpost
    carriers: {
      yamato: {
        name: 'ヤマト運輸',
        // 担当営業所（センター）のメールアドレス。送り状データと集荷依頼を送る先。
        email: env('YAMATO_EMAIL'),
        customerCode: env('YAMATO_CUSTOMER_CODE'), // ご請求先顧客コード（契約時に発行）
        freightCode: env('YAMATO_FREIGHT_CODE', '01'), // 運賃管理番号
        trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number01=',
      },
      japanpost: {
        name: '日本郵便（ゆうパック）',
        email: env('JAPANPOST_EMAIL'),
        customerCode: env('JAPANPOST_CUSTOMER_CODE'),
        trackingUrl: 'https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=',
      },
    },
    cutoff: env('SHIP_CUTOFF', '12:00'), // この時刻までの入金分は当日発送。同時刻に業者へデータ送信。
    shippedNoticeAt: env('SHIPPED_NOTICE_AT', '18:00'), // 発送日のこの時刻に「発送しました」メール
    closedWeekdays: list('CLOSED_WEEKDAYS', '0').map(Number), // 0=日曜
    holidays: list('HOLIDAYS', ''), // 休業日 YYYY-MM-DD,YYYY-MM-DD
    maxBoxKg: Number(env('MAX_BOX_KG', '20')), // 1箱に入れる上限重量
    feePerBox: Number(env('SHIPPING_FEE_PER_BOX', '990')), // 1箱あたり送料（税込・全国一律）
    freeShippingFrom: Number(env('FREE_SHIPPING_FROM', '10000')), // この金額以上で送料無料（0で無効）
    timeSlots: ['指定なし', '午前中', '14-16時', '16-18時', '18-20時', '19-21時'],
  },

  shop: {
    name: '翔米',
    nameKana: 'ショウマイ',
    tagline: '精米したてを、まっすぐ食卓へ。',
    sender: {
      // ご依頼主（送り状に印字される差出人）
      name: env('SENDER_NAME', '近藤米穀店 らいすぴあ'),
      nameKana: env('SENDER_NAME_KANA', 'ｺﾝﾄﾞｳﾍﾞｲｺｸﾃﾝ'),
      zip: env('SENDER_ZIP', '000-0000'),
      address: env('SENDER_ADDRESS', '愛知県○○市○○町1-2-3'),
      tel: env('SENDER_TEL', '000-000-0000'),
    },
    // 特定商取引法に基づく表記（公開前に必ず実情報へ書き換えること）
    legal: {
      販売業者: env('LEGAL_SELLER', '近藤米穀店'),
      運営責任者: env('LEGAL_MANAGER', '（要記入）'),
      所在地: env('LEGAL_ADDRESS', '（要記入）'),
      電話番号: env('LEGAL_TEL', '（要記入）'),
      メールアドレス: env('LEGAL_EMAIL', '（要記入）'),
      販売価格: '各商品ページに記載（税込）',
      商品代金以外の必要料金: '送料（1箱ごと・全国一律、一定額以上で無料）、コンビニ払い手数料はかかりません',
      支払方法: 'クレジットカード、コンビニ払い',
      支払時期: 'クレジットカード：ご注文時 / コンビニ払い：ご注文後3日以内',
      引渡時期: '入金確認後、原則1〜3営業日以内に発送',
      返品・交換: '食品のためお客様都合の返品はお受けできません。不良品・誤配送の場合は到着後7日以内にご連絡ください。送料当店負担で交換いたします。',
    },
  },

  // 商品マスタ。価格は仮。id は変えないこと（注文データに残るため）。
  products: [
    { id: 'shomai-2kg', name: '翔米 2kg', weightKg: 2, price: 1980, initialStock: 50, description: 'まずはお試しに。' },
    { id: 'shomai-5kg', name: '翔米 5kg', weightKg: 5, price: 4280, initialStock: 50, description: 'いちばん人気。ご家庭の定番に。' },
    { id: 'shomai-10kg', name: '翔米 10kg', weightKg: 10, price: 8280, initialStock: 30, description: 'たっぷり食べるご家庭に。' },
  ],
};

export const isDemo = () => !config.stripe.secretKey;
