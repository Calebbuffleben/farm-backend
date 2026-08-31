import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MessageType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CoreIngestService } from '../channel/core-ingest.service';
import type { NormalizedInbound } from '../channel/core-ingest.service';
import type {
  CloudApiMedia,
  CloudApiMessage,
  CloudApiWebhookPayload,
} from './webhook.types';

export {
  SESSION_INACTIVITY_MS,
  shouldRollSession,
} from '../channel/core-ingest.service';

const MEDIA_TYPES: Record<string, MessageType> = {
  audio: 'AUDIO',
  image: 'IMAGE',
  document: 'DOCUMENT',
};

/** Cloud API → shape do CoreIngest. `externalId` prefixado para não colidir com voz/e-mail. */
export function normalizeWabaInbound(
  tenantId: string,
  endpointId: string,
  msg: CloudApiMessage,
): NormalizedInbound | null {
  if (!msg.id || !msg.from) return null;
  const peerAddress = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;
  const type: MessageType =
    msg.type === 'text' ? 'TEXT' : (MEDIA_TYPES[msg.type ?? ''] ?? 'OTHER');
  const media: CloudApiMedia | undefined =
    msg.audio ?? msg.image ?? msg.document;
  const fixtureKind =
    msg.type === 'audio'
      ? 'audio'
      : msg.type === 'document'
        ? 'document'
        : msg.type === 'image'
          ? 'image'
          : undefined;
  const fixtureName = fixtureFileName(media?.id, fixtureKind);
  const fixtureMime =
    fixtureKind === 'audio'
      ? 'audio/wav'
      : fixtureKind === 'document'
        ? 'application/pdf'
        : 'image/jpeg';
  const mediaRef =
    media?.id || media?.url
      ? fixtureName
        ? ({
            vendor: 'fixture',
            fixtureName,
            mimeType: media?.mime_type ?? fixtureMime,
            attempts: 0,
          } satisfies Prisma.JsonObject)
        : ({
            vendor: 'meta',
            metaMediaId: media.id ?? null,
            metaUrl: media.url ?? null,
            mimeType: media.mime_type ?? null,
            sha256: media.sha256 ?? null,
            filename: media.filename ?? null,
            attempts: 0,
          } satisfies Prisma.JsonObject)
      : undefined;
  return {
    tenantId,
    endpointId,
    peerAddress,
    externalId: `wamid:${msg.id}`,
    direction: 'IN',
    type,
    body:
      msg.type === 'text'
        ? (msg.text?.body ?? null)
        : (media?.caption ?? null),
    sentAt: msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000)
      : new Date(),
    mediaRef,
  };
}

/**
 * inbound de teste: media.id = "fixture" | "fixture:<arquivo>" — sem Cloud API.
 * Default: lavoura.jpg (image), sample.wav (audio).
 */
export function fixtureFileName(
  mediaId: string | undefined,
  kind?: 'audio' | 'image' | 'document',
): string | null {
  if (!mediaId) return null;
  const fallback =
    kind === 'audio'
      ? 'sample.wav'
      : kind === 'document'
        ? 'sample.pdf'
        : 'lavoura.jpg';
  if (mediaId === 'fixture') return fallback;
  if (mediaId.startsWith('fixture:')) {
    const name = mediaId.slice('fixture:'.length).replace(/[/\\]/g, '');
    return name || fallback;
  }
  return null;
}

/**
 * Adapter WABA: valida o número, mapeia Cloud API e delega ao CoreIngest.
 * Webhook continua 200 imediato no controller — isto roda depois.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
  ) {}

  /** Processa um payload completo de webhook já validado. Nunca lança. */
  async ingestWebhookPayload(
    accountId: string,
    tenantId: string,
    payload: CloudApiWebhookPayload,
  ): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.metadata?.phone_number_id) continue;
        const number = await this.prisma.wabaNumber.findUnique({
          where: { phoneNumberId: value.metadata.phone_number_id },
          include: { channelEndpoint: true },
        });
        if (!number || number.wabaAccountId !== accountId) {
          this.logger.warn(
            `webhook for unknown/mismatched phone_number_id=${value.metadata.phone_number_id} account=${accountId}`,
          );
          continue;
        }
        if (!number.channelEndpoint) {
          this.logger.warn(
            `waba number ${number.id} missing ChannelEndpoint — skip ingest`,
          );
          continue;
        }
        for (const msg of value.messages ?? []) {
          const normalized = normalizeWabaInbound(
            tenantId,
            number.channelEndpoint.id,
            msg,
          );
          if (!normalized) continue;
          try {
            await this.core.ingest(normalized);
          } catch (err) {
            this.logger.error(
              `ingest failed wamid=${msg.id}: ${(err as Error).message}`,
            );
          }
        }
      }
    }
  }
}
