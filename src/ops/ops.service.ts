import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import {
  isPendingMediaStale,
  PENDING_MEDIA_STALE_MS,
  renderPrometheus,
} from './ops.policy';

@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Fire-and-forget — ingestão/webhook nunca espera o insert. */
  record(event: {
    service: string;
    stage: string;
    message: string;
    tenantId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    userId?: string | null;
    severity?: string;
    metadata?: Record<string, unknown>;
  }): void {
    void this.prisma.operationalEvent
      .create({
        data: {
          service: event.service,
          stage: event.stage,
          message: event.message,
          tenantId: event.tenantId ?? undefined,
          conversationId: event.conversationId ?? undefined,
          messageId: event.messageId ?? undefined,
          userId: event.userId ?? undefined,
          severity: event.severity ?? 'info',
          metadata: event.metadata as Prisma.InputJsonValue | undefined,
        },
      })
      .catch((err: Error) =>
        this.logger.warn(`operationalEvent failed: ${err.message}`),
      );
  }

  audit(input: {
    tenantId: string;
    userId: string;
    action: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }): void {
    void this.prisma.auditLog
      .create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          action: input.action,
          target: input.target,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      })
      .catch((err: Error) =>
        this.logger.warn(`auditLog failed: ${err.message}`),
      );
  }

  async snapshot() {
    return this.tenantCtx.runWithTenantBypass(async () => {
    const staleCutoff = new Date(Date.now() - PENDING_MEDIA_STALE_MS);
    const [
      unknownPending,
      pendingMedia,
      stalePendingMedia,
      openFacts,
      revokedConsents,
    ] = await Promise.all([
      this.prisma.unknownQueueItem.count({ where: { status: 'PENDING' } }),
      this.prisma.message.count({ where: { mediaStatus: 'PENDING_MEDIA' } }),
      this.prisma.message.count({
        where: { mediaStatus: 'PENDING_MEDIA', createdAt: { lte: staleCutoff } },
      }),
      this.prisma.commercialFact.count({ where: { status: 'OPEN' } }),
      this.prisma.consentRecord.count({ where: { revokedAt: { not: null } } }),
    ]);
    return {
      unknownPending,
      pendingMedia,
      stalePendingMedia,
      openFacts,
      revokedConsents,
      pendingMediaStaleMs: PENDING_MEDIA_STALE_MS,
    };
    });
  }

  async prometheusText(): Promise<string> {
    const s = await this.snapshot();
    return renderPrometheus([
      {
        name: 'farm_unknown_pending',
        help: 'UnknownQueueItem PENDING',
        value: s.unknownPending,
      },
      {
        name: 'farm_pending_media',
        help: 'Messages waiting for MediaWorker',
        value: s.pendingMedia,
      },
      {
        name: 'farm_pending_media_stale',
        help: 'PENDING_MEDIA older than 10 minutes',
        value: s.stalePendingMedia,
      },
      {
        name: 'farm_facts_open',
        help: 'CommercialFact OPEN',
        value: s.openFacts,
      },
      {
        name: 'farm_consent_revoked',
        help: 'ConsentRecord with revokedAt set',
        value: s.revokedConsents,
      },
    ]);
  }

  isStale(createdAt: Date, now = new Date()): boolean {
    return isPendingMediaStale(createdAt, now);
  }
}
