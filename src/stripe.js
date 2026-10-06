// Stripe REST API の最小クライアント（SDK不要）。
import crypto from 'node:crypto';
import { config } from './config.js';

const API_VERSION = '2024-06-20';

/** ネストしたオブジェクトを Stripe 形式の form-urlencoded に変換 */
export function encodeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encodeForm(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call(method, pathname, params) {
  const res = await fetch(`https://api.stripe.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      'Stripe-Version': API_VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? encodeForm(params) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${pathname} 失敗: ${body.error?.message ?? res.status}`);
  return body;
}

export const createCheckoutSession = (params) => call('POST', '/checkout/sessions', params);
export const retrieveCheckoutSession = (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`);

/** Stripe-Signature ヘッダーを検証して event を返す。不正なら例外。 */
export function verifyWebhook(rawBody, signatureHeader, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.groupBy((signatureHeader ?? '').split(',').map((p) => p.split('=')), ([k]) => k);
  const t = parts.t?.[0]?.[1];
  const signatures = (parts.v1 ?? []).map(([, v]) => v);
  if (!t || signatures.length === 0) throw new Error('署名ヘッダーがありません');
  if (Math.abs(nowSec - Number(t)) > toleranceSec) throw new Error('署名の有効期限切れ');

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = signatures.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('署名が一致しません');
  return JSON.parse(rawBody);
}
