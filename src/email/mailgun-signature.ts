import { createHmac, timingSafeEqual } from 'crypto';

const FRESH_SEC = 15 * 60;

/**
 * Mailgun webhook: HMAC-SHA256(timestamp + token, signing key) em hex.
 * Timing-safe. Timestamp fora de 15 min → rejeita (replay).
 */
export function verifyMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
  signature: string,
  nowSec = Date.now() / 1000,
): boolean {
  if (!signingKey || !timestamp || !token || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > FRESH_SEC) return false;
  const expected = createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
  const provided = signature.trim();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
