import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(process.env.SHOMAI_DB === ':memory:' ? ':memory:' : path.join(config.dataDir, 'shop.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS stock (
      product_id TEXT PRIMARY KEY,
      quantity   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkouts (
      session_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
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
      created_at         TEXT NOT NULL,
      paid_at            TEXT,
      sent_to_carrier_at TEXT,
      shipped_at         TEXT
    );
    CREATE TABLE IF NOT EXISTS boxes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      INTEGER NOT NULL REFERENCES orders(id),
      box_no        INTEGER NOT NULL,
      weight_kg     REAL NOT NULL,
      size          INTEGER NOT NULL,
      contents_json TEXT NOT NULL,
      tracking_no   TEXT,
      packed        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      key    TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    );
  `);
  const seed = db.prepare('INSERT OR IGNORE INTO stock (product_id, quantity) VALUES (?, ?)');
  for (const p of config.products) seed.run(p.id, p.initialStock);
  return db;
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** テスト用：DBを作り直す */
export function resetDb() {
  if (db) db.close();
  db = undefined;
}
