import * as jwt from 'jsonwebtoken';

import type { TwilioCreds } from './voice.client';

const TOKEN_TTL_SEC = 3600;

export function voiceClientIdentity(userId: string): string {
  return `farm_${userId}`;
}

export function userIdFromVoiceIdentity(identity: string): string | null {
  return identity.startsWith('farm_') ? identity.slice(5) : null;
}

export function parseVoiceClientFrom(from: string): string | null {
  const raw = from.trim();
  const prefixed = raw.match(/^client:(.+)$/i);
  return prefixed ? prefixed[1] : null;
}

/** JWT Twilio FPA (sem SDK). Assinado com API Key, não com Auth Token. */
export function mintVoiceAccessToken(
  creds: TwilioCreds,
  identity: string,
): { token: string; expiresAt: string; outgoing: boolean } {
  if (!creds.apiKeySid || !creds.apiKeySecret) {
    throw new Error('Twilio API Key (SK) não configurada');
  }
  const outgoing = Boolean(creds.twimlAppSid);
  const now = Math.floor(Date.now() / 1000);
  const grants: Record<string, unknown> = {
    identity,
    voice: {
      incoming: { allow: true },
      ...(outgoing
        ? { outgoing: { application_sid: creds.twimlAppSid } }
        : {}),
    },
  };
  const token = jwt.sign(
    { jti: `${creds.apiKeySid}-${now}`, grants },
    creds.apiKeySecret,
    {
      algorithm: 'HS256',
      header: { alg: 'HS256', cty: 'twilio-fpa;v=1', typ: 'JWT' },
      issuer: creds.apiKeySid,
      subject: creds.accountSid,
      expiresIn: TOKEN_TTL_SEC,
    },
  );
  return {
    token,
    expiresAt: new Date((now + TOKEN_TTL_SEC) * 1000).toISOString(),
    outgoing,
  };
}

export function recordingCallbackUrl(
  origin: string,
  accountId: string,
  our: string,
  peer: string,
  direction: 'IN' | 'OUT',
): string {
  const u = new URL(`${origin}/voice/recording/${accountId}`);
  u.searchParams.set('our', our);
  u.searchParams.set('peer', peer);
  u.searchParams.set('dir', direction);
  return u.toString();
}
