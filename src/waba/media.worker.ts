import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { RedisStreamService } from './redis-stream.service';
import { ConsentService } from '../consent/consent.service';
import { OpsService } from '../ops/ops.service';
import {
  mediaExpiresAt,
  mediaRetentionDays,
  PENDING_MEDIA_STALE_MS,
} from '../ops/ops.policy';
import { MediaFetchService, type MediaRef } from './media-fetch.service';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 5;

/**
 * Worker assíncrono de mídia: usa o próprio banco como fila
 * (Message.mediaStatus=PENDING_MEDIA). Baixa do canal, tenta gravar no
 * object storage (player do inbox) e publica farm:messages:ready.
 * Persistência é best-effort: sem S3 a análise ainda corre (ingest +
 * GET /internal/messages/:id/media baixa do canal na hora do STT).
 */
@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly stream: RedisStreamService,
    private readonly consent: ConsentService,
    private readonly ops: OpsService,
    private readonly mediaFetch: MediaFetchService,
  ) {}

  onModuleInit() {
    if (process.env.MEDIA_WORKER_ENABLED === 'false') {
      this.logger.warn('MediaWorker disabled via MEDIA_WORKER_ENABLED=false');
      return;
    }
    if (!this.storage.enabled) {
      this.logger.warn(
        'object storage off — player do inbox sem arquivo; análise de áudio segue pelo canal',
      );
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
    direction: string;
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
    const downloaded = await this.mediaFetch.download(message, ref);

    const contentType =
      downloaded.contentType.split(';')[0]?.trim() ||
      ref.mimeType?.split(';')[0]?.trim() ||
      'application/octet-stream';
    const storageKey = `${message.tenantId}/${message.conversationId}/${message.id}`;
    const assetId = await this.persistBestEffort(
      message,
      storageKey,
      downloaded.data,
      contentType,
    );

    await this.prisma.message.update({
      where: { id: message.id },
      data: { mediaStatus: 'READY', mediaAssetId: assetId },
    });
    if (ref.stagingKey && this.storage.enabled) {
      await this.storage.removeObject(ref.stagingKey);
    }

    // AUDIO já entra no stream na ingestão. Outros tipos (imagem/anexo)
    // só ficam analisáveis depois do download.
    if (
      message.type !== 'AUDIO' &&
      message.direction === 'IN' &&
      (await this.consent.canAnalyze(
        message.tenantId,
        message.conversation.producerId,
      ))
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
      `media ready message=${message.id} bytes=${downloaded.data.length} stored=${Boolean(assetId)}`,
    );
  }

  /** Grava no S3 se existir; falha de persistência não impede READY. */
  private async persistBestEffort(
    message: { id: string; tenantId: string },
    storageKey: string,
    data: Buffer,
    contentType: string,
  ): Promise<string | null> {
    if (!this.storage.enabled) {
      this.logger.warn(
        `persist skipped (no object storage) message=${message.id}`,
      );
      return null;
    }
    try {
      await this.storage.putObject(storageKey, data, contentType);
      const asset = await this.prisma.mediaAsset.create({
        data: {
          tenantId: message.tenantId,
          storageKey,
          contentType,
          sizeBytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          expiresAt: mediaExpiresAt(
            new Date(),
            mediaRetentionDays(process.env.MEDIA_RETENTION_DAYS),
          ),
        },
      });
      return asset.id;
    } catch (err) {
      this.logger.warn(
        `persist failed message=${message.id}: ${(err as Error).message} — análise não espera o storage`,
      );
      return null;
    }
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
    this.logger.warn(
      `pending_media stale=${stale} older than ${PENDING_MEDIA_STALE_MS}ms`,
    );
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
    if (!this.storage.enabled) return;
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
