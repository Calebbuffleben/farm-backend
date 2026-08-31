import { Injectable, Logger } from '@nestjs/common';
import { decryptSecret } from '../waba/waba-crypto';

export type MailgunCreds = {
  apiKey: string;
  domain: string;
  signingKey: string;
  region: 'us' | 'eu';
};

export function mailgunApiBase(region: 'us' | 'eu' | undefined): string {
  return region === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
}

export function parseEmailCredentials(
  credentialsEncrypted: string | null | undefined,
): MailgunCreds {
  if (!credentialsEncrypted) {
    throw new Error('ChannelAccount missing credentialsEncrypted');
  }
  const parsed = JSON.parse(decryptSecret(credentialsEncrypted)) as {
    apiKey?: string;
    domain?: string;
    signingKey?: string;
    region?: string;
  };
  if (!parsed.apiKey || !parsed.domain) {
    throw new Error('ChannelAccount credentials missing apiKey/domain');
  }
  if (!parsed.signingKey) {
    throw new Error('ChannelAccount credentials missing signingKey');
  }
  return {
    apiKey: parsed.apiKey,
    domain: parsed.domain,
    signingKey: parsed.signingKey,
    region: parsed.region === 'eu' ? 'eu' : 'us',
  };
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
}

/**
 * Cliente REST Mailgun. Sem SDK — fetch + Basic `api:{key}`.
 */
@Injectable()
export class EmailClient {
  private readonly logger = new Logger(EmailClient.name);

  async sendMessage(
    creds: MailgunCreds,
    input: {
      from: string;
      to: string;
      subject: string;
      text: string;
      inReplyTo?: string;
      references?: string;
    },
  ): Promise<{ id: string }> {
    const body = new URLSearchParams({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    if (input.inReplyTo) body.set('h:In-Reply-To', input.inReplyTo);
    if (input.references) body.set('h:References', input.references);
    const res = await fetch(
      `${mailgunApiBase(creds.region)}/v3/${creds.domain}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(creds.apiKey),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };
    if (!res.ok || !data.id) {
      this.logger.warn(`sendMessage failed ${res.status}: ${data.message ?? ''}`);
      throw new Error(data.message || `Mailgun sendMessage ${res.status}`);
    }
    return { id: data.id };
  }

  async download(creds: MailgunCreds, url: string): Promise<Buffer> {
    const res = await fetch(url, {
      headers: { Authorization: basicAuth(creds.apiKey) },
    });
    if (!res.ok) {
      throw new Error(`Mailgun attachment download ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
