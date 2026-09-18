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
  isOverdueFollowup,
  rollingWindow,
  type DashboardCuts,
  type FactRow,
} from './dashboard.queries';
import {
  applyDealCuts,
  buildCommand,
  toDealCard,
  type DealRow,
} from './dashboard.command';
import type { DealLevel, DealStage } from './deal-temperature';

/** Teto: dashboard do ano 1 cabe em memória. Upgrade: paginar por pergunta. */
const OPEN_FACT_CAP = 2000;
/** Mesmo teto para briefs: 1 por conversa, cabe em memória no ano 1. */
const DEAL_CAP = 2000;

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
    const [rawFacts, unknownPending, briefs] = await Promise.all([
      this.loadOpenFacts(tenantId, window.previousFrom),
      this.prisma.unknownQueueItem.count({
        where: { tenantId, status: 'PENDING' },
      }),
      this.loadBriefs(tenantId),
    ]);
    const rtvIds = [
      ...new Set(
        [...rawFacts.map((r) => r.rtvUserId), ...briefs.map((b) => b.rtvUserId)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const names = await this.loadRtvNames(rtvIds);
    const all = rawFacts.map((r) => ({
      ...r,
      rtvName: r.rtvUserId ? (names.get(r.rtvUserId) ?? null) : null,
    }));
    const filtered = applyCuts(all, cuts);
    const home = buildHome(filtered, now, window, unknownPending);
    const deals = this.assembleDeals(briefs, all, names, now);
    const command = buildCommand(applyDealCuts(deals, cuts), now);

    return {
      ...home,
      ...command,
      cuts: this.mergeCuts(collectCuts(all), deals),
    };
  }

  /** Drawer do negócio: brief + temperatura + fatos abertos com evidência. */
  async getDeal(tenantId: string, userId: string, conversationId: string) {
    const now = new Date();
    const brief = await this.prisma.dealBrief.findFirst({
      where: { tenantId, conversationId },
      include: {
        conversation: {
          select: {
            producerPhone: true,
            peerAddress: true,
            producer: {
              select: {
                id: true,
                name: true,
                farms: { select: { id: true, name: true, region: true } },
              },
            },
            messages: {
              orderBy: { sentAt: 'desc' },
              take: 1,
              select: { sentAt: true, direction: true },
            },
          },
        },
      },
    });
    if (!brief) throw new NotFoundException('Negócio sem brief ainda');

    const facts = await this.prisma.commercialFact.findMany({
      where: {
        tenantId,
        status: 'OPEN',
        evidenceMessage: { conversationId },
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        subtype: true,
        severity: true,
        confidence: true,
        headline: true,
        moneyHint: true,
        dueHintText: true,
        dueAt: true,
        occurredAt: true,
        productKey: true,
        evidenceMessageId: true,
        evidenceSpan: true,
        farm: { select: { name: true } },
      },
    });

    const rtv = brief.rtvUserId
      ? await this.prisma.user.findUnique({
          where: { id: brief.rtvUserId },
          select: { name: true, email: true },
        })
      : null;

    const last = brief.conversation.messages[0];
    const card = toDealCard(
      {
        conversationId,
        producerId: brief.producerId,
        producerName: brief.conversation.producer?.name ?? null,
        producerPhone:
          brief.conversation.producerPhone ?? brief.conversation.peerAddress,
        farmNames: brief.conversation.producer?.farms.map((f) => f.name) ?? [],
        rtvUserId: brief.rtvUserId,
        rtvName: rtv?.name?.trim() || rtv?.email || null,
        stage: brief.stage as DealStage,
        stageConfidence: brief.stageConfidence,
        contextSummary: brief.contextSummary,
        producerPosition: brief.producerPosition,
        dealChange: brief.dealChange,
        intent: brief.intent as DealLevel,
        urgency: brief.urgency as DealLevel,
        painPoint: brief.painPoint,
        nextAction: brief.nextAction,
        nextActionReason: brief.nextActionReason,
        nextActionOwner: brief.nextActionOwner,
        nextActionKind: brief.nextActionKind,
        nextActionDueHint: brief.nextActionDueHint,
        nextActionDueAt: brief.nextActionDueAt,
        suggestedReply: brief.suggestedReply,
        managerGuidance: brief.managerGuidance,
        analysisQuality: brief.analysisQuality,
        blockerSubtype: brief.blockerSubtype,
        products: Array.isArray(brief.products)
          ? (brief.products as string[])
          : [],
        updatedAt: brief.updatedAt,
        lastMessageAt: last?.sentAt ?? null,
        lastDirection: (last?.direction as 'IN' | 'OUT' | undefined) ?? null,
        openComplaints: facts.filter(
          (f) => f.kind === 'OBJECAO' || f.kind === 'RISCO',
        ).length,
        overdueFollowups: facts.filter(
          (f) =>
            f.kind === 'FOLLOWUP' &&
            f.dueAt !== null &&
            f.dueAt.getTime() <= now.getTime(),
        ).length,
        moneyHints: facts
          .map((f) => f.moneyHint)
          .filter((m): m is string => Boolean(m)),
        criticalFacts: facts
          .filter((f) => f.severity === 'CRITICAL')
          .map((f) => f.headline)
          .slice(0, 3),
        crops: [],
        regions: [],
        productKeys: [],
        farmIds: [],
      },
      now,
    );

    this.ops.audit({
      tenantId,
      userId,
      action: 'dashboard.deal.view',
      target: conversationId,
      metadata: { evidenceMessageId: brief.evidenceMessageId },
    });

    return {
      ...card,
      stageConfidence: brief.stageConfidence,
      evidenceMessageId: brief.evidenceMessageId,
      facts: facts.map((f) => ({
        id: f.id,
        kind: f.kind,
        subtype: f.subtype,
        severity: f.severity,
        confidence: f.confidence,
        headline: f.headline,
        moneyHint: f.moneyHint,
        dueHintText: f.dueHintText,
        dueAt: f.dueAt,
        occurredAt: f.occurredAt,
        productKey: f.productKey,
        farmName: f.farm?.name ?? null,
        evidenceMessageId: f.evidenceMessageId,
        evidenceSpan: f.evidenceSpan,
        conversationId,
      })),
    };
  }

  /**
   * DealBrief + última mensagem por conversa. Fatos abertos vêm da carga já
   * feita para as 5 perguntas (mesma janela) — nada de segunda varredura.
   */
  private loadBriefs(tenantId: string) {
    return this.prisma.dealBrief.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: DEAL_CAP,
      include: {
        conversation: {
          select: {
            producerPhone: true,
            peerAddress: true,
            producer: {
              select: {
                name: true,
                farms: { select: { id: true, name: true, region: true } },
              },
            },
            messages: {
              orderBy: { sentAt: 'desc' },
              take: 1,
              select: { sentAt: true, direction: true },
            },
          },
        },
      },
    });
  }

  private assembleDeals(
    briefs: Awaited<ReturnType<DashboardService['loadBriefs']>>,
    facts: FactRow[],
    names: Map<string, string>,
    now: Date,
  ): DealRow[] {
    if (!briefs.length) return [];

    const factsByConversation = new Map<string, FactRow[]>();
    for (const fact of facts) {
      const list = factsByConversation.get(fact.conversationId);
      if (list) list.push(fact);
      else factsByConversation.set(fact.conversationId, [fact]);
    }

    return briefs.map((b) => {
      const convFacts = factsByConversation.get(b.conversationId) ?? [];
      const farms = b.conversation.producer?.farms ?? [];
      const last = b.conversation.messages[0];
      const uniq = (values: Array<string | null>) => [
        ...new Set(values.filter((v): v is string => Boolean(v))),
      ];
      return {
        conversationId: b.conversationId,
        producerId: b.producerId,
        producerName: b.conversation.producer?.name ?? null,
        producerPhone:
          b.conversation.producerPhone ?? b.conversation.peerAddress,
        farmNames: farms.map((f) => f.name),
        rtvUserId: b.rtvUserId,
        rtvName: b.rtvUserId ? (names.get(b.rtvUserId) ?? null) : null,
        stage: b.stage as DealStage,
        stageConfidence: b.stageConfidence,
        contextSummary: b.contextSummary,
        producerPosition: b.producerPosition,
        dealChange: b.dealChange,
        intent: b.intent as DealLevel,
        urgency: b.urgency as DealLevel,
        painPoint: b.painPoint,
        nextAction: b.nextAction,
        nextActionReason: b.nextActionReason,
        nextActionOwner: b.nextActionOwner,
        nextActionKind: b.nextActionKind,
        nextActionDueHint: b.nextActionDueHint,
        nextActionDueAt: b.nextActionDueAt,
        suggestedReply: b.suggestedReply,
        managerGuidance: b.managerGuidance,
        analysisQuality: b.analysisQuality,
        blockerSubtype: b.blockerSubtype,
        products: Array.isArray(b.products) ? (b.products as string[]) : [],
        updatedAt: b.updatedAt,
        lastMessageAt: last?.sentAt ?? null,
        lastDirection: (last?.direction as 'IN' | 'OUT' | undefined) ?? null,
        openComplaints: convFacts.filter(
          (f) => f.kind === 'OBJECAO' || f.kind === 'RISCO',
        ).length,
        overdueFollowups: convFacts.filter((f) => isOverdueFollowup(f, now))
          .length,
        moneyHints: uniq(convFacts.map((f) => f.moneyHint)),
        criticalFacts: convFacts
          .filter((f) => f.severity === 'CRITICAL')
          .map((f) => f.headline)
          .slice(0, 3),
        crops: uniq(convFacts.map((f) => f.crop)),
        regions: uniq([
          ...convFacts.map((f) => f.region),
          ...farms.map((f) => f.region),
        ]),
        productKeys: uniq(convFacts.map((f) => f.productKey)),
        farmIds: uniq([
          ...convFacts.map((f) => f.farmId),
          ...farms.map((f) => f.id),
        ]),
      };
    });
  }

  /** RTVs que só têm brief (sem fato na janela) também entram no filtro. */
  private mergeCuts(cuts: ReturnType<typeof collectCuts>, deals: DealRow[]) {
    const rtvs = new Map(cuts.rtvs.map((r) => [r.id, r.name] as const));
    for (const d of deals) {
      if (d.rtvUserId && !rtvs.has(d.rtvUserId))
        rtvs.set(d.rtvUserId, d.rtvName ?? d.rtvUserId);
    }
    return {
      ...cuts,
      rtvs: [...rtvs.entries()].map(([id, name]) => ({ id, name })),
    };
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
        OR: [{ occurredAt: { gte: since } }, { kind: 'FOLLOWUP' }],
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

  private async loadRtvNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.name?.trim() || u.email] as const));
  }
}
