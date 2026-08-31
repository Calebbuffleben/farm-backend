import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FactStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { FactsIngestService } from '../internal/facts-ingest.service';
import { OpsService } from '../ops/ops.service';
import { InboxService } from '../waba/inbox.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import {
  discountReplySendsText,
  isDiscountReplyFact,
} from './dashboard.discount';
import {
  applyCuts,
  buildHome,
  collectCuts,
  rollingWindow,
  type DashboardCuts,
  type FactRow,
} from './dashboard.queries';

/** Teto: dashboard do ano 1 cabe em memória. Upgrade: paginar por pergunta. */
const OPEN_FACT_CAP = 2000;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factsIngest: FactsIngestService,
    private readonly ops: OpsService,
    private readonly inbox: InboxService,
  ) {}

  async home(tenantId: string, days: number, cuts: DashboardCuts) {
    const now = new Date();
    const window = rollingWindow(now, days);
    const [raw, unknownPending] = await Promise.all([
      this.loadOpenFacts(tenantId, window.previousFrom),
      this.prisma.unknownQueueItem.count({
        where: { tenantId, status: 'PENDING' },
      }),
    ]);
    const all = await this.withRtvNames(raw);
    const filtered = applyCuts(all, cuts);
    const home = buildHome(filtered, now, window, unknownPending);
    return { ...home, cuts: collectCuts(all) };
  }

  async getFact(tenantId: string, userId: string, factId: string) {
    const fact = await this.prisma.commercialFact.findFirst({
      where: { id: factId, tenantId },
      include: {
        farm: { select: { id: true, name: true, region: true, state: true } },
        producer: { select: { name: true } },
        cropSeason: { select: { crop: true, seasonLabel: true } },
        evidenceMessage: {
          select: {
            id: true,
            type: true,
            body: true,
            transcript: true,
            sentAt: true,
            conversationId: true,
            mediaAssetId: true,
            conversation: {
              select: {
                channelEndpoint: {
                  select: { channelAccount: { select: { kind: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!fact) throw new NotFoundException('Fato não encontrado');

    const rtv = fact.rtvUserId
      ? await this.prisma.user.findUnique({
          where: { id: fact.rtvUserId },
          select: { name: true, email: true },
        })
      : null;
    const rtvName = rtv?.name?.trim() || rtv?.email || null;

    this.ops.audit({
      tenantId,
      userId,
      action: 'dashboard.evidence.view',
      target: fact.id,
      metadata: { evidenceMessageId: fact.evidenceMessageId },
    });

    return {
      id: fact.id,
      kind: fact.kind,
      subtype: fact.subtype,
      severity: fact.severity,
      status: fact.status,
      headline: fact.headline,
      moneyHint: fact.moneyHint,
      dueHintText: fact.dueHintText,
      dueAt: fact.dueAt,
      occurredAt: fact.occurredAt,
      farmId: fact.farmId,
      farmName: fact.farm?.name ?? null,
      region: fact.farm?.region ?? fact.region,
      crop: fact.cropSeason?.crop ?? null,
      productKey: fact.productKey,
      rtvUserId: fact.rtvUserId,
      rtvName,
      producerName: fact.producer?.name ?? null,
      evidenceSpan: fact.evidenceSpan,
      evidence: {
        messageId: fact.evidenceMessage.id,
        conversationId: fact.evidenceMessage.conversationId,
        type: fact.evidenceMessage.type,
        body: fact.evidenceMessage.body,
        transcript: fact.evidenceMessage.transcript,
        sentAt: fact.evidenceMessage.sentAt,
        mediaAssetId: fact.evidenceMessage.mediaAssetId,
      },
      channelKind:
        fact.evidenceMessage.conversation.channelEndpoint.channelAccount.kind,
      farmState: fact.farm?.state
        ? {
            farmId: fact.farm.id,
            name: fact.farm.name,
            region: fact.farm.region,
            openFacts: fact.farm.state.openFacts,
            lastFactAt: fact.farm.state.lastFactAt,
          }
        : null,
    };
  }

  async patchFact(tenantId: string, factId: string, status: FactStatus) {
    const existing = await this.prisma.commercialFact.findFirst({
      where: { id: factId, tenantId },
      select: { id: true, farmId: true },
    });
    if (!existing) throw new NotFoundException('Fato não encontrado');
    const updated = await this.prisma.commercialFact.update({
      where: { id: existing.id },
      data: {
        status,
        resolvedAt: status === 'OPEN' ? null : new Date(),
      },
    });
    if (existing.farmId) {
      await this.factsIngest.refreshFarmState(tenantId, existing.farmId);
    }
    return { id: updated.id, status: updated.status };
  }

  async discountReply(user: TenantContext, factId: string, text: string) {
    const fact = await this.prisma.commercialFact.findFirst({
      where: { id: factId, tenantId: user.tenantId },
      include: {
        evidenceMessage: {
          select: {
            conversationId: true,
            conversation: {
              select: {
                channelEndpoint: {
                  select: { channelAccount: { select: { kind: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!fact) throw new NotFoundException('Fato não encontrado');
    if (!isDiscountReplyFact(fact.kind, fact.subtype)) {
      throw new BadRequestException(
        'Alçada de desconto só em objeção de preço',
      );
    }

    const channelKind =
      fact.evidenceMessage.conversation.channelEndpoint.channelAccount.kind;
    const conversationId = fact.evidenceMessage.conversationId;
    const body = text.trim();
    if (!body) {
      throw new BadRequestException('Texto da resposta vazio');
    }
    const sends = discountReplySendsText(channelKind);
    let sent = false;
    try {
      if (sends) {
        await this.inbox.sendText(user, conversationId, body);
        sent = true;
      } else {
        this.logger.log(
          `discount-reply ligar fact=${fact.id} conversation=${conversationId}`,
        );
        this.ops.record({
          service: 'dashboard',
          stage: 'discount-reply',
          message: 'ligar',
          tenantId: user.tenantId,
          conversationId,
          userId: user.userId,
          metadata: { factId: fact.id, channel: channelKind },
        });
      }
    } finally {
      this.ops.audit({
        tenantId: user.tenantId,
        userId: user.userId,
        action: 'dashboard.discount.reply',
        target: fact.id,
        metadata: {
          conversationId,
          channel: channelKind,
          sent,
          text: body,
        },
      });
    }

    return { ok: true as const, sent, channel: channelKind };
  }

  private async loadOpenFacts(
    tenantId: string,
    since: Date,
  ): Promise<FactRow[]> {
    const facts = await this.prisma.commercialFact.findMany({
      where: {
        tenantId,
        status: 'OPEN',
        OR: [
          { occurredAt: { gte: since } },
          { kind: 'FOLLOWUP' },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: OPEN_FACT_CAP,
      include: {
        farm: { select: { name: true, region: true } },
        producer: { select: { name: true } },
        cropSeason: { select: { crop: true } },
        evidenceMessage: { select: { conversationId: true } },
      },
    });
    return facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      subtype: fact.subtype,
      severity: fact.severity,
      headline: fact.headline,
      moneyHint: fact.moneyHint,
      dueHintText: fact.dueHintText,
      dueAt: fact.dueAt,
      occurredAt: fact.occurredAt,
      farmId: fact.farmId,
      farmName: fact.farm?.name ?? null,
      region: fact.farm?.region ?? fact.region,
      crop: fact.cropSeason?.crop ?? null,
      productKey: fact.productKey,
      rtvUserId: fact.rtvUserId,
      rtvName: null,
      producerName: fact.producer?.name ?? null,
      evidenceMessageId: fact.evidenceMessageId,
      evidenceSpan: fact.evidenceSpan,
      conversationId: fact.evidenceMessage.conversationId,
    }));
  }

  private async withRtvNames(rows: FactRow[]): Promise<FactRow[]> {
    const ids = [
      ...new Set(rows.map((r) => r.rtvUserId).filter((id): id is string => Boolean(id))),
    ];
    if (!ids.length) return rows;
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    const names = new Map(
      users.map((u) => [u.id, u.name?.trim() || u.email] as const),
    );
    return rows.map((r) => ({
      ...r,
      rtvName: r.rtvUserId ? (names.get(r.rtvUserId) ?? null) : null,
    }));
  }
}
