import type { Prisma } from '@prisma/client';
import type { NormalizedInbound } from '../channel/core-ingest.service';

/**
 * Subconjunto do payload de webhook da Evolution API v2 (eventos
 * MESSAGES_UPSERT e CONNECTION_UPDATE). `apikey` = token da instância.
 */
export interface EvolutionWebhook {
  event?: string;
  instance?: string;
  apikey?: string;
  data?: {
    key?: {
      remoteJid?: string;
      /** Baileys LID: E.164 alternativo quando remoteJid vier `@lid`. */
      remoteJidAlt?: string;
      senderPn?: string;
      fromMe?: boolean;
      id?: string;
    };
    pushName?: string;
    messageType?: string;
    /** Segundos Unix (número ou string). */
    messageTimestamp?: number | string;
    message?: EvolutionMessage;
    state?: 'open' | 'connecting' | 'close';
    statusReason?: number;
  };
}

interface EvolutionMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  audioMessage?: { mimetype?: string };
  imageMessage?: { mimetype?: string; caption?: string };
  documentMessage?: { mimetype?: string; fileName?: string; title?: string; caption?: string };
  documentWithCaptionMessage?: { message?: EvolutionMessage };
  videoMessage?: { mimetype?: string; caption?: string };
  ephemeralMessage?: { message?: EvolutionMessage };
  viewOnceMessage?: { message?: EvolutionMessage };
  viewOnceMessageV2?: { message?: EvolutionMessage };
  viewOnceMessageV2Extension?: { message?: EvolutionMessage };
}

export function evolutionEvent(p: EvolutionWebhook): 'message' | 'connected' | 'disconnected' | 'other' {
  const ev = (p.event ?? '').toUpperCase().replace(/\./g, '_');
  if (ev === 'MESSAGES_UPSERT') return 'message';
  if (ev === 'CONNECTION_UPDATE') {
    if (p.data?.state === 'open') return 'connected';
    if (p.data?.state === 'close') return 'disconnected';
  }
  return 'other';
}

/**
 * MESSAGES_UPSERT → NormalizedInbound. Grupos, status e newsletter ficam de
 * fora (o produto é 1:1). fromMe = RTV digitou no celular: persiste OUT;
 * CoreIngest não publica OUT. Sem E.164 resolvível (só `@lid`) → descarta.
 */
export function evolutionToInbound(
  p: EvolutionWebhook,
  ctx: { tenantId: string; endpointId: string },
): NormalizedInbound | null {
  const key = p.data?.key;
  if (!key?.id) return null;
  const digits = peerDigits(key);
  if (!digits) return null;

  const ts = Number(p.data?.messageTimestamp);
  const base = {
    tenantId: ctx.tenantId,
    endpointId: ctx.endpointId,
    peerAddress: `+${digits}`,
    externalId: `evo:${key.id}`,
    direction: (key.fromMe ? 'OUT' : 'IN') as 'IN' | 'OUT',
    sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
  };

  const msg = unwrap(p.data?.message);
  const text = (msg?.conversation ?? msg?.extendedTextMessage?.text)?.trim();
  if (text) return { ...base, type: 'TEXT', body: text };

  const media = pickMedia(msg);
  if (media) {
    return {
      ...base,
      type: media.type,
      body: media.caption ?? null,
      mediaRef: {
        vendor: 'evolution',
        messageId: key.id,
        mimeType: media.mimeType ?? null,
        filename: media.filename ?? null,
        attempts: 0,
      } satisfies Prisma.JsonObject,
    };
  }
  return { ...base, type: 'OTHER', body: null };
}

/** Dígitos E.164 do peer; null para grupo/status/newsletter ou LID sem alternativa. */
function peerDigits(key: NonNullable<EvolutionWebhook['data']>['key']): string | null {
  const jid = key?.remoteJid ?? '';
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return null;
  const candidate = jid.endsWith('@lid') ? key?.remoteJidAlt ?? key?.senderPn ?? '' : jid;
  const digits = candidate.split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function unwrap(m: EvolutionMessage | undefined): EvolutionMessage | undefined {
  if (!m) return m;
  if (m.ephemeralMessage?.message) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrap(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension?.message) {
    return unwrap(m.viewOnceMessageV2Extension.message);
  }
  if (m.documentWithCaptionMessage?.message) {
    return unwrap(m.documentWithCaptionMessage.message);
  }
  return m;
}

function pickMedia(m: EvolutionMessage | undefined): {
  type: 'AUDIO' | 'IMAGE' | 'DOCUMENT' | 'OTHER';
  mimeType?: string;
  caption?: string;
  filename?: string;
} | null {
  if (!m) return null;
  if (m.audioMessage) return { type: 'AUDIO', mimeType: m.audioMessage.mimetype };
  if (m.imageMessage) return { type: 'IMAGE', mimeType: m.imageMessage.mimetype, caption: m.imageMessage.caption };
  if (m.documentMessage) {
    return {
      type: 'DOCUMENT',
      mimeType: m.documentMessage.mimetype,
      caption: m.documentMessage.caption,
      filename: m.documentMessage.fileName ?? m.documentMessage.title,
    };
  }
  if (m.videoMessage) return { type: 'OTHER', mimeType: m.videoMessage.mimetype, caption: m.videoMessage.caption };
  return null;
}
