import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * AES-256-GCM para o token do BSP em repouso.
 * Formato armazenado: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`.
 * Chave: CHANNEL_TOKEN_ENCRYPTION_KEY (fallback WABA_TOKEN_ENCRYPTION_KEY) —
 * 32 bytes em hex (64 chars) ou base64.
 */

function loadKey(): Buffer {
  const raw =
    process.env.CHANNEL_TOKEN_ENCRYPTION_KEY?.trim() ||
    process.env.WABA_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'CHANNEL_TOKEN_ENCRYPTION_KEY (or WABA_TOKEN_ENCRYPTION_KEY) is not configured',
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'CHANNEL_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex-64 or base64)',
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }
  const key = loadKey();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Valida `X-Hub-Signature-256` (padrão Meta Cloud API): HMAC-SHA256 do corpo
 * cru com o webhookSecret. Retorna true quando o secret não está configurado
 * na conta (validação opcional no ano 1 — BSPs variam no suporte).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  webhookSecret: string | null | undefined,
): boolean {
  if (!webhookSecret) return true;
  if (!rawBody || !signatureHeader) return false;
  const expected = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.replace(/^sha256=/, '').trim();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
