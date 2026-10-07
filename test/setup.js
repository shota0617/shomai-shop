// テスト共通：一時ディレクトリ・デモモードの設定（DB はメモリ上）。src より先に読み込むこと。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'shomai-test-'));
process.env.STRIPE_SECRET_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.CLOSED_WEEKDAYS = '0';
process.env.HOLIDAYS = '2026-10-12';
process.env.SHIP_CUTOFF = '12:00';
process.env.YAMATO_EMAIL = 'center@yamato.example';
process.env.OWNER_EMAIL = 'owner@shop.example';
