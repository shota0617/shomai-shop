// テスト共通：.env を読まず、一時ディレクトリ＋メモリDB・デモモードで動かす
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.SHOMAI_SKIP_DOTENV = '1';
process.env.SHOMAI_DB = ':memory:';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'shomai-test-'));
process.env.STRIPE_SECRET_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.CLOSED_WEEKDAYS = '0';
process.env.HOLIDAYS = '2026-10-12';
process.env.SHIP_CUTOFF = '12:00';
process.env.YAMATO_EMAIL = 'center@yamato.example';
process.env.OWNER_EMAIL = 'owner@shop.example';
