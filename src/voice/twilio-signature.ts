import { createHmac, timingSafeEqual } from 'crypto';

import { farmPublicUrl } from '../channel/public-origin';

/**
 * Valida `X-Twilio-Signature`: HMAC-SHA1 da URL absoluta + params POST
 * ordenados (chave+valor concatenados), Base64. Timing-safe.
 */
export function verifyTwilioSignature(
  authToken: string,
  signatureHeader: string | undefined,
  url: string,
  params: Record<string, string | string[] | undefined>,
): boolean {
  if (!signatureHeader) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      if (value === undefined) return acc;
      const rendered = Array.isArray(value) ? value.join('') : String(value);
      return acc + key + rendered;
    }, url);
  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const provided = signatureHeader.trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function twilioWebhookUrl(req: {
  protocol: string;
  originalUrl: string;
  get: (name: string) => string | undefined;
}): string {
  return `${farmPublicOrigin(req)}${req.originalUrl}`;
}

export function farmPublicOrigin(req: {
  protocol: string;
  get: (name: string) => string | undefined;
}): string {
  const configured = farmPublicUrl();
  if (configured) return configured;
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}
