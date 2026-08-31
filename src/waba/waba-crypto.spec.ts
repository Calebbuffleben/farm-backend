import { randomBytes, createHmac } from 'crypto';
import {
  decryptSecret,
  encryptSecret,
  verifyWebhookSignature,
} from './waba-crypto';

describe('waba-crypto', () => {
  const originalChannel = process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
  const originalWaba = process.env.WABA_TOKEN_ENCRYPTION_KEY;

  beforeAll(() => {
    delete process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
    process.env.WABA_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  });

  afterAll(() => {
    if (originalChannel === undefined) delete process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
    else process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = originalChannel;
    if (originalWaba === undefined) delete process.env.WABA_TOKEN_ENCRYPTION_KEY;
    else process.env.WABA_TOKEN_ENCRYPTION_KEY = originalWaba;
  });

  it('encrypts and decrypts roundtrip', () => {
    const secret = 'd360-api-key-super-secreta';
    const stored = encryptSecret(secret);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it('produces distinct ciphertexts per call (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('rejects tampered ciphertext', () => {
    const stored = encryptSecret('token');
    const parts = stored.split(':');
    parts[3] = Buffer.from('adulterado').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  describe('verifyWebhookSignature', () => {
    const secret = 'webhook-secret';
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp' }));

    it('accepts valid sha256= signature', () => {
      const sig =
        'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
      expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    });

    it('rejects wrong signature', () => {
      expect(verifyWebhookSignature(body, 'sha256=' + '0'.repeat(64), secret)).toBe(
        false,
      );
    });

    it('rejects missing signature when secret configured', () => {
      expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    });

    it('passes through when account has no secret', () => {
      expect(verifyWebhookSignature(body, undefined, null)).toBe(true);
    });
  });

  it('prefers CHANNEL_TOKEN_ENCRYPTION_KEY over the WABA name', () => {
    const waba = process.env.WABA_TOKEN_ENCRYPTION_KEY;
    process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const stored = encryptSecret('canal');
    expect(decryptSecret(stored)).toBe('canal');
    delete process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
    process.env.WABA_TOKEN_ENCRYPTION_KEY = waba;
  });
});
