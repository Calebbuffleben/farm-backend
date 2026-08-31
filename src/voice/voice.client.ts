import { Injectable, Logger } from '@nestjs/common';
import { decryptSecret } from '../waba/waba-crypto';

export type TwilioCreds = {
  accountSid: string;
  authToken: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  twimlAppSid?: string;
};

export function parseVoiceCredentials(
  credentialsEncrypted: string | null | undefined,
): TwilioCreds {
  if (!credentialsEncrypted) {
    throw new Error('ChannelAccount missing credentialsEncrypted');
  }
  const parsed = JSON.parse(decryptSecret(credentialsEncrypted)) as {
    accountSid?: string;
    authToken?: string;
    apiKeySid?: string;
    apiKeySecret?: string;
    twimlAppSid?: string;
  };
  if (!parsed.accountSid || !parsed.authToken) {
    throw new Error('ChannelAccount credentials missing accountSid/authToken');
  }
  return {
    accountSid: parsed.accountSid,
    authToken: parsed.authToken,
    apiKeySid: parsed.apiKeySid?.trim() || undefined,
    apiKeySecret: parsed.apiKeySecret?.trim() || undefined,
    twimlAppSid: parsed.twimlAppSid?.trim() || undefined,
  };
}

function basicAuth(creds: TwilioCreds): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

export type TwilioCall = {
  sid: string;
  from: string;
  to: string;
  direction: string;
};

/**
 * Cliente REST Twilio Voice. Sem SDK — fetch + Basic auth.
 */
@Injectable()
export class VoiceClient {
  private readonly logger = new Logger(VoiceClient.name);

  async createCall(
    creds: TwilioCreds,
    input: { from: string; to: string; url: string },
  ): Promise<{ sid: string }> {
    const body = new URLSearchParams({
      From: input.from,
      To: input.to,
      Url: input.url,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(creds),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !data.sid) {
      this.logger.warn(`createCall failed ${res.status}: ${data.message ?? ''}`);
      throw new Error(data.message || `Twilio createCall ${res.status}`);
    }
    return { sid: data.sid };
  }

  async getCall(creds: TwilioCreds, callSid: string): Promise<TwilioCall> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls/${callSid}.json`,
      { headers: { Authorization: basicAuth(creds) } },
    );
    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      from?: string;
      to?: string;
      direction?: string;
      message?: string;
    };
    if (!res.ok || !data.sid || !data.from || !data.to) {
      throw new Error(data.message || `Twilio getCall ${res.status}`);
    }
    return {
      sid: data.sid,
      from: data.from,
      to: data.to,
      direction: data.direction ?? 'inbound',
    };
  }

  async downloadMp3(creds: TwilioCreds, url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { Authorization: basicAuth(creds) } });
    if (!res.ok) {
      throw new Error(`Twilio recording download ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
