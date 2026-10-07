// データベースの共通窓口。
// Cloudflare では D1、Node.js（手元・テスト・Docker）では組み込みの SQLite を、同じ書き方で使う。
//   get(sql, ...params)  → 1行（なければ null）
//   all(sql, ...params)  → 行の配列
//   run(sql, ...params)  → { changes }
//   batch([[sql, ...params], ...]) → 各文の { changes }。全部成功するか、全部取り消されるか。
import { config } from './config.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stock (
    product_id TEXT PRIMARY KEY,
    quantity   INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS checkouts (
    session_id TEXT PRIMARY KEY,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no           TEXT UNIQUE NOT NULL,
    session_id         TEXT UNIQUE NOT NULL,
    status             TEXT NOT NULL, -- awaiting_payment | paid | sent_to_carrier | shipped | canceled
    email              TEXT NOT NULL,
    name               TEXT NOT NULL,
    phone              TEXT NOT NULL,
    zip                TEXT NOT NULL,
    address1           TEXT NOT NULL,
    address2           TEXT NOT NULL DEFAULT '',
    time_slot          TEXT NOT NULL DEFAULT '指定なし',
    items_json         TEXT NOT NULL,
    subtotal           INTEGER NOT NULL,
    shipping_fee       INTEGER NOT NULL,
    total              INTEGER NOT NULL,
    carrier            TEXT NOT NULL,
    ship_date          TEXT,
    pay_nonce          TEXT,
    created_at         TEXT NOT NULL,
    paid_at            TEXT,
    sent_to_carrier_at TEXT,
    shipped_at         TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS boxes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(id),
    box_no        INTEGER NOT NULL,
    weight_kg     REAL NOT NULL,
    size          INTEGER NOT NULL,
    contents_json TEXT NOT NULL,
    tracking_no   TEXT,
    packed        INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    key    TEXT PRIMARY KEY,
    ran_at TEXT NOT NULL
  )`,
];

let current;

export function setDb(adapter) {
  current = adapter;
}

/** 初回だけ表を作り、商品の在庫行を用意する */
export async function getDb() {
  if (!current) throw new Error('データベースが設定されていません（setDb を呼んでください）');
  if (!current.ready) {
    current.ready = (async () => {
      await current.batch(SCHEMA.map((sql) => [sql]));
      await current.batch(config.products.map((p) => ['INSERT OR IGNORE INTO stock (product_id, quantity) VALUES (?, ?)', p.id, p.initialStock]));
    })();
    current.ready.catch(() => { current.ready = undefined; });
  }
  await current.ready;
  return current;
}

/** Cloudflare D1 */
export function d1Adapter(d1) {
  const stmt = (sql, params) => d1.prepare(sql).bind(...params);
  return {
    get: async (sql, ...params) => (await stmt(sql, params).first()) ?? null,
    all: async (sql, ...params) => (await stmt(sql, params).all()).results,
    run: async (sql, ...params) => ({ changes: (await stmt(sql, params).run()).meta.changes }),
    batch: async (list) => (await d1.batch(list.map(([sql, ...params]) => stmt(sql, params)))).map((r) => ({ changes: r.meta.changes })),
  };
}

/** Node.js 組み込みの SQLite（node:sqlite）。file は DBファイルのパスか ':memory:' */
export async function nodeSqliteAdapter(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const plain = (row) => (row ? { ...row } : null);
  return {
    get: async (sql, ...params) => plain(db.prepare(sql).get(...params)),
    all: async (sql, ...params) => db.prepare(sql).all(...params).map(plain),
    run: async (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    batch: async (list) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = list.map(([sql, ...params]) => ({ changes: Number(db.prepare(sql).run(...params).changes) }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}
