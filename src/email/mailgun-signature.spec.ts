import { createHmac } from 'crypto';
import { verifyMailgunSignature } from './mailgun-signature';
import { mailgunApiBase } from './email.client';
import {
  collectAttachments,
  composeEmailBody,
  emailExternalId,
  emailOutboundSubject,
  parseMailgunHeaders,
  recipientAddresses,
  shouldDiscardInbound,
  takeAttachmentBudget,
  EMAIL_MAX_ATTACHMENTS,
} from './mailgun-parse';

describe('verifyMailgunSignature', () => {
  const key = 'signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = 'tok123';
  const signature = createHmac('sha256', key)
    .update(timestamp + token)
    .digest('hex');

  it('accepts a valid HMAC-SHA256 hex signature', () => {
    expect(verifyMailgunSignature(key, timestamp, token, signature)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyMailgunSignature(key, timestamp, token, 'deadbeef')).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const old = String(Math.floor(Date.now() / 1000) - 16 * 60);
    const sig = createHmac('sha256', key).update(old + token).digest('hex');
    expect(verifyMailgunSignature(key, old, token, sig)).toBe(false);
  });
});

describe('mailgun parse', () => {
  it('builds email: wamid from Message-Id', () => {
    expect(emailExternalId('<abc@mg.example>', '1', 't')).toBe('email:abc@mg.example');
  });

  it('falls back to timestamp+token without Message-Id', () => {
    expect(emailExternalId(undefined, '99', 'tok')).toBe('email:mg:99:tok');
  });

  it('prefixes Assunto and strips HTML when plain is empty', () => {
    expect(composeEmailBody('Safra', '', '<p>Olá&nbsp;<b>João</b></p>')).toBe(
      'Assunto: Safra\n\nOlá João',
    );
  });

  it('parses message-headers JSON', () => {
    const headers = parseMailgunHeaders(
      JSON.stringify([
        ['From', 'Ada <ada@x.com>'],
        ['List-Unsubscribe', '<mailto:x>'],
      ]),
    );
    expect(headers['list-unsubscribe']).toBe('<mailto:x>');
  });

  it('discards noreply, mailer-daemon, Auto-Submitted, List-Id', () => {
    expect(
      shouldDiscardInbound({ sender: 'noreply@x.com', headers: {} }),
    ).toBe(true);
    expect(
      shouldDiscardInbound({ sender: 'MAILER-DAEMON@x.com', headers: {} }),
    ).toBe(true);
    expect(
      shouldDiscardInbound({
        sender: 'ada@x.com',
        headers: { 'auto-submitted': 'auto-replied' },
      }),
    ).toBe(true);
    expect(
      shouldDiscardInbound({
        sender: 'ada@x.com',
        headers: { 'list-unsubscribe': '<mailto:x>' },
      }),
    ).toBe(false);
    expect(
      shouldDiscardInbound({
        sender: 'ada@x.com',
        headers: { 'list-id': '<list.x.com>' },
      }),
    ).toBe(true);
    expect(
      shouldDiscardInbound({ sender: 'ada@x.com', headers: {} }),
    ).toBe(false);
  });

  it('splits recipients', () => {
    expect(recipientAddresses('Ada <a@x.com>, b@y.com')).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });

  it('collects multipart files named attachment-N', () => {
    const atts = collectAttachments(
      {},
      [
        {
          fieldname: 'attachment-1',
          originalname: 'nf.pdf',
          mimetype: 'application/pdf',
          size: 12,
          buffer: Buffer.from('pdf'),
        },
      ],
    );
    expect(atts[0].filename).toBe('nf.pdf');
  });

  it('drops attachments over the 10-file ceiling', () => {
    const items = Array.from({ length: EMAIL_MAX_ATTACHMENTS + 2 }, (_, i) => ({
      filename: `f${i}`,
      mimeType: 'text/plain',
      size: 1,
      buffer: Buffer.from('x'),
    }));
    const { kept, dropped } = takeAttachmentBudget(items);
    expect(kept).toHaveLength(EMAIL_MAX_ATTACHMENTS);
    expect(dropped).toBe(2);
  });

  it('prefixes Re: on existing thread and uses requested subject on a new one', () => {
    expect(emailOutboundSubject('Safra soja', undefined, 'oi')).toBe('Re: Safra soja');
    expect(emailOutboundSubject('Re: Safra soja', 'ignore', 'oi')).toBe('Re: Safra soja');
    expect(emailOutboundSubject(null, 'Cotação', 'corpo longo')).toBe('Cotação');
    expect(emailOutboundSubject(null, undefined, 'só o corpo')).toBe('só o corpo');
  });

  it('points EU accounts at api.eu.mailgun.net', () => {
    expect(mailgunApiBase('eu')).toBe('https://api.eu.mailgun.net');
    expect(mailgunApiBase('us')).toBe('https://api.mailgun.net');
  });
});
