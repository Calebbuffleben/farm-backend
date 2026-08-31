/**
 * Origem que Twilio/Mailgun chamam. Tem que ser a mesma URL colada no
 * console do vendor — senão a assinatura HMAC não bate.
 */
export function farmPublicUrl(): string | null {
  const base = process.env.FARM_PUBLIC_URL?.replace(/\/$/, '').trim();
  return base || null;
}
