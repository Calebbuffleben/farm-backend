import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { WabaCloudFactory } from './waba-cloud';
import { StorageService } from './storage.service';
import { RedisStreamService } from './redis-stream.service';
import { decryptSecret } from './waba-crypto';
import { ConsentService } from '../consent/consent.service';
import { OpsService } from '../ops/ops.service';
import { parseVoiceCredentials, VoiceClient } from '../voice/voice.client';
import { twilioRecordingUrl } from '../voice/twilio-media';
import { parseEmailCredentials, EmailClient } from '../email/email.client';
import {
  mediaExpiresAt,
  mediaRetentionDays,
  PENDING_MEDIA_STALE_MS,
} from '../ops/ops.policy';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 5;

interface MediaRef {
  vendor?: string;
  metaMediaId?: string | null;
  metaUrl?: string | null;
  mimeType?: string | null;
  sha256?: string | null;
  filename?: string | null;
  recordingUrl?: string | null;
  recordingSid?: string | null;
  accountSid?: string | null;
  url?: string | null;
  stagingKey?: string | null;
  fixtureName?: string | null;
  attempts?: number;
}

/**
 * Worker assíncrono de mídia: usa o próprio banco como fila
 * (Message.mediaStatus=PENDING_MEDIA). Baixa da CDN da Meta via BSP ou Graph
 * API (META_DIRECT), grava a cópia permanente no object storage e só então
 * publica farm:messages:ready.
 * A URL da Meta expira — se expirou, refaz via GET /{media-id}.
 */
@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wabaCloud: WabaCloudFactory,
    private readonly storage: StorageService,
    private readonly stream: RedisStreamService,
    private readonly consent: ConsentService,
    private readonly ops: OpsService,
    private readonly voice: VoiceClient,
    private readonly email: EmailClient,
  ) {}

  onModuleInit() {
    if (process.env.MEDIA_WORKER_ENABLED === 'false') {
      this.logger.warn('MediaWorker disabled via MEDIA_WORKER_ENABLED=false');
      return;
    }
    if (
      !this.storage.enabled
    ) {
      this.logger.error(
        'MediaWorker idle — object storage not configured; áudio e anexo ficam presos em PENDING_MEDIA',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.logger.log(`MediaWorker polling every ${POLL_INTERVAL_MS}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // sem sobreposição de ciclos
    this.running = true;
    try {
      await this.processBatch();
      await this.alarmStale();
      await this.purgeExpired();
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async processBatch(): Promise<void> {
    const pending = await this.prisma.message.findMany({
      where: { mediaStatus: 'PENDING_MEDIA', tenantId: { not: '' } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: {
        conversation: {
          include: {
            wabaNumber: { include: { wabaAccount: true } },
            channelEndpoint: { include: { channelAccount: true } },
          },
        },
      },
    });
    for (const message of pending) {
      try {
        await this.processOne(message);
      } catch (err) {
        await this.registerFailure(message.id, message.mediaRef, err as Error);
      }
    }
  }

  private async processOne(message: {
    id: string;
    tenantId: string;
    conversationId: string;
    sessionId: string | null;
    type: string;
    mediaRef: Prisma.JsonValue;
    conversation: {
      producerId: string | null;
      wabaNumber: {
        phoneNumberId: string;
        wabaAccount: { apiTokenEncrypted: string; provider: string };
      } | null;
      channelEndpoint: {
        channelAccount: { credentialsEncrypted: string | null };
      } | null;
    };
  }): Promise<void> {
    const ref = (message.mediaRef ?? {}) as unknown as MediaRef;
    const downloaded =
      ref.vendor === 'fixture'
        ? await this.downloadFixture(ref)
        : ref.vendor === 'twilio'
          ? await this.downloadTwilio(message, ref)
          : ref.vendor === 'mailgun'
            ? await this.downloadMailgun(message, ref)
            : await this.downloadMeta(message, ref);

    const contentType =
      ref.mimeType?.split(';')[0]?.trim() || downloaded.contentType;
    const storageKey = `${message.tenantId}/${message.conversationId}/${message.id}`;
    await this.storage.putObject(storageKey, downloaded.data, contentType);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId: message.tenantId,
        storageKey,
        contentType,
        sizeBytes: downloaded.data.length,
        sha256: createHash('sha256').update(downloaded.data).digest('hex'),
        expiresAt: mediaExpiresAt(
          new Date(),
          mediaRetentionDays(process.env.MEDIA_RETENTION_DAYS),
        ),
      },
    });
    await this.prisma.message.update({
      where: { id: message.id },
      data: { mediaStatus: 'READY', mediaAssetId: asset.id },
    });
    if (ref.stagingKey) {
      await this.storage.removeObject(ref.stagingKey);
    }

    if (
      await this.consent.canAnalyze(
        message.tenantId,
        message.conversation.producerId,
      )
    ) {
      await this.stream.publishMessageReady({
        messageId: message.id,
        tenantId: message.tenantId,
        conversationId: message.conversationId,
        sessionId: message.sessionId ?? '',
        type: message.type,
      });
    }
    this.logger.log(
      `media ready message=${message.id} bytes=${downloaded.data.length}`,
    );
  }

  /**
   * Teste local sem Meta: lê farm/fixtures/<nome>.
   * Inbound: image.id = "fixture:lavoura.jpg".
   */
  private async downloadFixture(
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const raw = ref.fixtureName || ref.filename || 'lavoura.jpg';
    const name = basename(raw);
    if (!name || name !== raw.replace(/[/\\]/g, '')) {
      throw new Error('fixtureName inválido');
    }
    const root =
      process.env.FARM_FIXTURES_DIR?.trim() ||
      join(process.cwd(), '..', 'fixtures');
    const data = await readFile(join(root, name));
    return {
      data,
      contentType: ref.mimeType?.split(';')[0]?.trim() || 'image/jpeg',
    };
  }

  private async downloadMeta(
    message: {
      conversation: {
        wabaNumber: {
          phoneNumberId: string;
          wabaAccount: { apiTokenEncrypted: string; provider: string };
        } | null;
      };
    },
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const number = message.conversation.wabaNumber;
    const token = number?.wabaAccount.apiTokenEncrypted;
    if (!number || !token) throw new Error('PENDING_MEDIA without WABA credentials');
    const apiKey = decryptSecret(token);
    const client = this.wabaCloud.for(
      number.wabaAccount.provider,
      number.phoneNumberId,
    );
    let url = ref.metaUrl ?? null;
    if (!url && ref.metaMediaId) {
      url = await client.getMediaUrl(apiKey, ref.metaMediaId);
    }
    if (!url) throw new Error('mediaRef has neither metaUrl nor metaMediaId');
    try {
      return await client.downloadMedia(apiKey, url);
    } catch (err) {
      if (ref.metaMediaId && url === ref.metaUrl) {
        const freshUrl = await client.getMediaUrl(apiKey, ref.metaMediaId);
        return client.downloadMedia(apiKey, freshUrl);
      }
      throw err;
    }
  }

  private async downloadTwilio(
    message: {
      conversation: {
        channelEndpoint: {
          channelAccount: { credentialsEncrypted: string | null };
        } | null;
      };
    },
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const encrypted =
      message.conversation.channelEndpoint?.channelAccount.credentialsEncrypted;
    const creds = parseVoiceCredentials(encrypted);
    const url = twilioRecordingUrl({
      recordingUrl: ref.recordingUrl,
      recordingSid: ref.recordingSid,
      accountSid: ref.accountSid ?? creds.accountSid,
    });
    const data = await this.voice.downloadMp3(creds, url);
    return { data, contentType: 'audio/mpeg' };
  }

  private async downloadMailgun(
    message: {
      conversation: {
        channelEndpoint: {
          channelAccount: { credentialsEncrypted: string | null };
        } | null;
      };
    },
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (ref.stagingKey) {
      const data = await this.storage.getObject(ref.stagingKey);
      return {
        data,
        contentType: ref.mimeType?.split(';')[0]?.trim() || 'application/octet-stream',
      };
    }
    if (!ref.url) throw new Error('mailgun mediaRef missing url and stagingKey');
    const encrypted =
      message.conversation.channelEndpoint?.channelAccount.credentialsEncrypted;
    const creds = parseEmailCredentials(encrypted);
    const data = await this.email.download(creds, ref.url);
    return {
      data,
      contentType: ref.mimeType?.split(';')[0]?.trim() || 'application/octet-stream',
    };
  }

  private async alarmStale(): Promise<void> {
    const cutoff = new Date(Date.now() - PENDING_MEDIA_STALE_MS);
    const stale = await this.prisma.message.count({
      where: {
        tenantId: { not: '' },
        mediaStatus: 'PENDING_MEDIA',
        createdAt: { lte: cutoff },
      },
    });
    if (stale === 0) return;
    this.logger.warn(`pending_media stale=${stale} older than ${PENDING_MEDIA_STALE_MS}ms`);
    this.ops.record({
      service: 'farm-backend',
      stage: 'media.pending.stale',
      message: `${stale} messages stuck in PENDING_MEDIA`,
      severity: 'warning',
      metadata: { stale },
    });
  }

  /** Expurgo LGPD: apaga bytes no storage; transcript/fatos ficam. */
  private async purgeExpired(): Promise<void> {
    const expired = await this.prisma.mediaAsset.findMany({
      where: { tenantId: { not: '' }, expiresAt: { lte: new Date() } },
      take: 20,
      include: { message: { select: { id: true } } },
    });
    for (const asset of expired) {
      await this.storage.removeObject(asset.storageKey);
      if (asset.message) {
        await this.prisma.message.update({
          where: { id: asset.message.id },
          data: { mediaAssetId: null },
        });
      }
      await this.prisma.mediaAsset.delete({ where: { id: asset.id } });
      this.ops.record({
        service: 'farm-backend',
        stage: 'media.purged',
        message: asset.storageKey,
        tenantId: asset.tenantId,
        messageId: asset.message?.id,
      });
    }
  }

  private async registerFailure(
    messageId: string,
    mediaRef: Prisma.JsonValue,
    err: Error,
  ): Promise<void> {
    const ref = (mediaRef ?? {}) as Record<string, unknown>;
    const attempts = (typeof ref.attempts === 'number' ? ref.attempts : 0) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    this.logger.warn(
      `media download attempt ${attempts}/${MAX_ATTEMPTS} failed message=${messageId}: ${err.message}`,
    );
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        mediaRef: { ...ref, attempts, lastError: err.message } as Prisma.JsonObject,
        ...(failed ? { mediaStatus: 'FAILED' as const } : {}),
      },
    });
  }
}
