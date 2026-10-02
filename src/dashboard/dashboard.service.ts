import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FactStatus, Prisma } from '@prisma/client';

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
  type TimeWindow,
} from './dashboard.queries';
import {
  applyDealCuts,
  buildCommand,
  toDealCard,
  type DealRow,
} from './dashboard.command';
import {
  TEMPERATURE_ORDER,
  dealTemperature,
  type DealLevel,
  type DealStage,
  type DealTemperature,
} from './deal-temperature';
import {
  buildScoreboard,
  buildSince,
  classifyMovement,
  hintedDiscountPct,
  nextVisit,
  planSync,
  readDiscountAuthority,
  shouldCaptureSnapshot,
  type AnalysisQuality,
  type InterventionDecision,
  type InterventionMovement,
  type InterventionStatus,
  type InterventionTrigger,
  type StoredIntervention,
} from './dashboard.outcome';
import {
  buildCompetitive,
  buildOpportunities,
  buildSilentFarms,
  type SilentFarmInput,
} from './dashboard.portfolio';

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

  async home(tenantId: string, userId: string, days: number, cuts: DashboardCuts) {
    const now = new Date();
    const window = rollingWindow(now, days);
    const [rawFacts, unknownPending, briefs, tenant] = await Promise.all([
      this.loadOpenFacts(tenantId, window.previousFrom),
      this.prisma.unknownQueueItem.count({
        where: { tenantId, status: 'PENDING' },
      }),
      this.loadBriefs(tenantId),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { salesPolicy: true },
      }),
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
    const visibleDeals = applyDealCuts(deals, cuts);
    const command = buildCommand(visibleDeals, now);
    const authority = readDiscountAuthority(tenant?.salesPolicy);
    const [interventions, since] = await Promise.all([
      this.syncInterventions(tenantId, deals, all, authority, now),
      this.touchVisit(tenantId, userId, now),
    ]);
    const visibleIds = new Set(visibleDeals.map((deal) => deal.conversationId));
    const visibleInterventions = interventions.filter((row) =>
      visibleIds.has(row.conversationId),
    );
    const sinceSummary = since
      ? await this.summarizeSince(tenantId, since, visibleInterventions, visibleIds, cuts)
      : null;

    return {
      ...home,
      ...command,
      cuts: this.mergeCuts(collectCuts(all), deals),
      outcome: this.presentOutcome(
        visibleInterventions,
        visibleDeals,
        window,
        sinceSummary,
        unknownPending,
      ),
      portfolio: {
        ...(await this.loadPortfolio(tenantId, filtered, visibleDeals, cuts, window, now)),
      },
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
        evidenceMessageId: brief.evidenceMessageId,
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
        evidenceMessageId: b.evidenceMessageId,
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

  async decideIntervention(
    user: TenantContext,
    interventionId: string,
    decision: InterventionDecision,
  ) {
    const row = await this.prisma.managerIntervention.findFirst({
      where: { id: interventionId, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Intervenção não encontrada');
    if (row.status !== 'OPEN') {
      throw new BadRequestException('Esta decisão já foi registrada');
    }
    const now = new Date();
    if (decision === 'DELEGATE' && !row.rtvUserId) {
      throw new BadRequestException('Sem RTV nesta conversa para delegar');
    }
    const data =
      decision === 'DISMISS'
        ? {
            status: 'DISMISSED' as const,
            decision,
            decidedById: user.userId,
            decidedAt: now,
            dismissedAt: now,
          }
        : {
            status: 'ACKNOWLEDGED' as const,
            decision,
            assigneeUserId: decision === 'ASSUME' ? user.userId : row.rtvUserId,
            decidedById: user.userId,
            decidedAt: now,
          };
    const updated = await this.prisma.managerIntervention.update({
      where: { id: row.id },
      data,
    });
    this.ops.audit({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'dashboard.intervention.decide',
      target: row.id,
      metadata: { decision, conversationId: row.conversationId },
    });
    return { id: updated.id, status: updated.status, decision: updated.decision };
  }

  async getIntervention(tenantId: string, interventionId: string) {
    const row = await this.prisma.managerIntervention.findFirst({
      where: { id: interventionId, tenantId },
    });
    if (!row) throw new NotFoundException('Intervenção não encontrada');
    const snapshots = await this.prisma.dealSnapshot.findMany({
      where: { tenantId, conversationId: row.conversationId },
      orderBy: { occurredAt: 'asc' },
      take: 40,
    });
    return {
      id: row.id,
      conversationId: row.conversationId,
      movement: row.movement,
      movementNote: row.movementNote,
      executionObservedAt: row.executionObservedAt?.toISOString() ?? null,
      producerRepliedAt: row.producerRepliedAt?.toISOString() ?? null,
      executionChannel: row.executionChannel,
      timeline: [
        {
          at: row.createdAt.toISOString(),
          stage: row.stage,
          temperature: row.temperature,
          blockerSubtype: row.blockerSubtype,
          label: 'Alerta aberto',
        },
        ...snapshots
          .filter((snapshot) => snapshot.occurredAt.getTime() > row.createdAt.getTime())
          .map((snapshot) => ({
            at: snapshot.occurredAt.toISOString(),
            stage: snapshot.stage,
            temperature: snapshot.temperature,
            blockerSubtype: snapshot.blockerSubtype,
            label: 'Leitura posterior',
          })),
      ],
    };
  }

  private async syncInterventions(
    tenantId: string,
    deals: DealRow[],
    facts: FactRow[],
    authorityPct: number | null,
    now: Date,
  ) {
    await this.captureSnapshots(tenantId, deals, now);
    const [existing, openSignals] = await Promise.all([
      this.loadInterventions(tenantId),
      this.prisma.commercialFact.findMany({
        where: {
          tenantId,
          status: 'OPEN',
          OR: [{ kind: 'CONCORRENTE' }, { moneyHint: { not: null } }],
        },
        take: 2000,
        select: {
          kind: true,
          moneyHint: true,
          evidenceMessage: { select: { conversationId: true } },
        },
      }),
    ]);
    const factsByConversation = groupFacts(facts);
    const signalsByConversation = new Map<string, { competitor: boolean; hints: string[] }>();
    for (const fact of openSignals) {
      const conversationId = fact.evidenceMessage.conversationId;
      const bucket = signalsByConversation.get(conversationId) ?? { competitor: false, hints: [] };
      if (fact.kind === 'CONCORRENTE') bucket.competitor = true;
      if (fact.moneyHint) bucket.hints.push(fact.moneyHint);
      signalsByConversation.set(conversationId, bucket);
    }
    const observed = await this.observeExecutions(tenantId, existing);
    const plan = planSync(
      deals.map((deal) =>
        toCandidate(
          deal,
          factsByConversation.get(deal.conversationId) ?? [],
          signalsByConversation.get(deal.conversationId),
          authorityPct,
          now,
        ),
      ),
      observed.map(toStored),
      now,
    );
    if (plan.create.length) {
      await this.prisma.managerIntervention.createMany({
        data: plan.create.map((draft) => ({
          tenantId,
          conversationId: draft.conversationId,
          trigger: draft.trigger,
          evidenceMessageId: draft.evidenceMessageId,
          stage: draft.stage,
          temperature: draft.temperature,
          intent: draft.intent,
          urgency: draft.urgency,
          stageConfidence: draft.stageConfidence,
          analysisQuality: draft.analysisQuality,
          blockerSubtype: draft.blockerSubtype,
          recommendedAction: draft.recommendedAction,
          recommendedKind: draft.recommendedKind,
          recommendedOwner: draft.recommendedOwner,
          dueAt: draft.dueAt,
          managerGuidance: draft.managerGuidance,
          moneyHints: draft.moneyHints,
          rtvUserId: draft.rtvUserId,
        })),
      });
    }
    if (plan.expireIds.length) {
      await this.prisma.managerIntervention.updateMany({
        where: { tenantId, id: { in: plan.expireIds } },
        data: { status: 'EXPIRED', expiredAt: now },
      });
    }
    const rows =
      plan.create.length || plan.expireIds.length
        ? await this.loadInterventions(tenantId)
        : observed;
    return this.observeMovement(tenantId, rows, deals, now);
  }

  private loadInterventions(tenantId: string) {
    return this.prisma.managerIntervention.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
  }

  private async captureSnapshots(tenantId: string, deals: DealRow[], now: Date) {
    const live = deals.filter((deal) => deal.analysisQuality !== 'STALE');
    if (!live.length) return;
    const previous = await this.prisma.dealSnapshot.findMany({
      where: { tenantId, conversationId: { in: live.map((deal) => deal.conversationId) } },
      orderBy: { occurredAt: 'desc' },
      distinct: ['conversationId'],
      select: { conversationId: true, stage: true, temperature: true, blockerSubtype: true },
    });
    const latest = new Map(previous.map((row) => [row.conversationId, row] as const));
    const data = live.flatMap((deal) => {
      const temperature = dealTemperature(
        {
          stage: deal.stage,
          intent: deal.intent,
          urgency: deal.urgency,
          lastMessageAt: deal.lastMessageAt,
          lastDirection: deal.lastDirection,
        },
        now,
      );
      const next = { stage: deal.stage, temperature, blockerSubtype: deal.blockerSubtype };
      if (!shouldCaptureSnapshot(latest.get(deal.conversationId) ?? null, next)) return [];
      return [
        {
          tenantId,
          conversationId: deal.conversationId,
          stage: deal.stage,
          temperature,
          intent: deal.intent,
          urgency: deal.urgency,
          blockerSubtype: deal.blockerSubtype,
          evidenceMessageId: deal.evidenceMessageId,
          occurredAt: now,
        },
      ];
    });
    if (data.length) await this.prisma.dealSnapshot.createMany({ data });
  }

  private async observeExecutions(
    tenantId: string,
    rows: InterventionRow[],
  ): Promise<InterventionRow[]> {
    const pending = rows.filter(
      (row) =>
        (row.status === 'ACKNOWLEDGED' && row.decidedAt) ||
        (row.status === 'EXECUTED' && row.executionObservedAt && !row.producerRepliedAt),
    );
    if (!pending.length) return rows;
    const floor = pending.reduce((min, row) => {
      const at = row.decidedAt ?? row.executionObservedAt ?? row.createdAt;
      return at.getTime() < min.getTime() ? at : min;
    }, pending[0].decidedAt ?? pending[0].executionObservedAt ?? pending[0].createdAt);
    const messages = await this.prisma.message.findMany({
      where: {
        tenantId,
        conversationId: { in: [...new Set(pending.map((row) => row.conversationId))] },
        sentAt: { gt: floor },
      },
      orderBy: { sentAt: 'asc' },
      take: 2000,
      select: {
        id: true,
        conversationId: true,
        direction: true,
        sentAt: true,
        conversation: {
          select: {
            channelEndpoint: { select: { channelAccount: { select: { kind: true } } } },
          },
        },
      },
    });
    const patches = new Map<string, Prisma.ManagerInterventionUpdateInput>();
    for (const row of pending) {
      const mine = messages.filter((message) => message.conversationId === row.conversationId);
      if (row.status === 'ACKNOWLEDGED' && row.decidedAt) {
        const outbound = mine.find(
          (message) => message.direction === 'OUT' && message.sentAt > row.decidedAt!,
        );
        if (!outbound) continue;
        const reply = mine.find(
          (message) => message.direction === 'IN' && message.sentAt > outbound.sentAt,
        );
        patches.set(row.id, {
          status: 'EXECUTED',
          executedAt: outbound.sentAt,
          executionObservedAt: outbound.sentAt,
          executionMessageId: outbound.id,
          executionChannel: outbound.conversation.channelEndpoint.channelAccount.kind,
          producerRepliedAt: reply?.sentAt ?? null,
        });
      } else if (row.executionObservedAt && !row.producerRepliedAt) {
        const reply = mine.find(
          (message) => message.direction === 'IN' && message.sentAt > row.executionObservedAt!,
        );
        if (reply) patches.set(row.id, { producerRepliedAt: reply.sentAt });
      }
    }
    if (!patches.size) return rows;
    await Promise.all(
      [...patches.entries()].map(([id, data]) =>
        this.prisma.managerIntervention.update({ where: { id }, data }),
      ),
    );
    return this.loadInterventions(tenantId);
  }

  private async observeMovement(
    tenantId: string,
    rows: InterventionRow[],
    deals: DealRow[],
    now: Date,
  ): Promise<InterventionRow[]> {
    const watch = rows.filter((row) => row.status === 'EXECUTED');
    if (!watch.length) return rows;
    const conversationIds = [...new Set(watch.map((row) => row.conversationId))];
    const earliest = watch.reduce(
      (min, row) => (row.createdAt < min ? row.createdAt : min),
      watch[0].createdAt,
    );
    const [critical, competitors, followups] = await Promise.all([
      this.prisma.commercialFact.findMany({
        where: {
          tenantId,
          severity: 'CRITICAL',
          occurredAt: { gt: earliest },
          evidenceMessage: { conversationId: { in: conversationIds } },
        },
        select: { occurredAt: true, evidenceMessage: { select: { conversationId: true } } },
      }),
      this.prisma.commercialFact.findMany({
        where: {
          tenantId,
          kind: 'CONCORRENTE',
          occurredAt: { gt: earliest },
          evidenceMessage: { conversationId: { in: conversationIds } },
        },
        select: { occurredAt: true, evidenceMessage: { select: { conversationId: true } } },
      }),
      this.prisma.commercialFact.findMany({
        where: {
          tenantId,
          kind: 'FOLLOWUP',
          status: 'RESOLVED',
          resolvedAt: { gt: earliest },
          evidenceMessage: { conversationId: { in: conversationIds } },
        },
        select: { resolvedAt: true, evidenceMessage: { select: { conversationId: true } } },
      }),
    ]);
    const dealById = new Map(deals.map((deal) => [deal.conversationId, deal] as const));
    const patches = new Map<
      string,
      { movement: InterventionMovement | null; movementNote: string | null; movementAt: Date | null }
    >();
    for (const row of watch) {
      const deal = dealById.get(row.conversationId);
      if (!deal) continue;
      const after = (at: Date) => at.getTime() > row.createdAt.getTime();
      const result = classifyMovement({
        birthStage: row.stage,
        birthTemperature: asTemperature(row.temperature),
        currentStage: deal.stage,
        currentTemperature: dealTemperature(
          {
            stage: deal.stage,
            intent: deal.intent,
            urgency: deal.urgency,
            lastMessageAt: deal.lastMessageAt,
            lastDirection: deal.lastDirection,
          },
          now,
        ),
        birthBlocker: row.blockerSubtype,
        currentBlocker: deal.blockerSubtype,
        dueAt: row.dueAt,
        now,
        executed: row.status === 'EXECUTED',
        newCritical: critical.some(
          (fact) => fact.evidenceMessage.conversationId === row.conversationId && after(fact.occurredAt),
        ),
        newCompetitor: competitors.some(
          (fact) => fact.evidenceMessage.conversationId === row.conversationId && after(fact.occurredAt),
        ),
        followupResolved: followups.some(
          (fact) =>
            fact.evidenceMessage.conversationId === row.conversationId &&
            fact.resolvedAt != null &&
            after(fact.resolvedAt),
        ),
      });
      if (result.movement === row.movement && result.note === row.movementNote) continue;
      patches.set(row.id, {
        movement: result.movement,
        movementNote: result.note,
        movementAt: result.movement ? now : null,
      });
    }
    if (!patches.size) return rows;
    await Promise.all(
      [...patches.entries()].map(([id, data]) =>
        this.prisma.managerIntervention.update({ where: { id }, data }),
      ),
    );
    return this.loadInterventions(tenantId);
  }

  private async touchVisit(tenantId: string, userId: string, now: Date) {
    const prev = await this.prisma.dashboardVisit.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    const next = nextVisit(
      prev
        ? { visitStartedAt: prev.visitStartedAt, visibleSinceAt: prev.visibleSinceAt }
        : null,
      now,
    );
    await this.prisma.dashboardVisit.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: {
        tenantId,
        userId,
        visitStartedAt: next.visitStartedAt,
        visibleSinceAt: next.visibleSinceAt,
      },
      update: {
        visitStartedAt: next.visitStartedAt,
        visibleSinceAt: next.visibleSinceAt,
      },
    });
    return next.since;
  }

  private async summarizeSince(
    tenantId: string,
    since: Date,
    interventions: InterventionRow[],
    visibleIds: Set<string>,
    cuts: DashboardCuts,
  ) {
    const conversationIds = [...visibleIds];
    if (!conversationIds.length) {
      return buildSince({ since, interventions: [], snapshots: [], threats: 0 });
    }
    const [after, threats] = await Promise.all([
      this.prisma.dealSnapshot.findMany({
        where: { tenantId, conversationId: { in: conversationIds }, occurredAt: { gt: since } },
        orderBy: { occurredAt: 'asc' },
        take: 2000,
        select: { conversationId: true, occurredAt: true, stage: true, temperature: true },
      }),
      this.prisma.commercialFact.count({
        where: {
          tenantId,
          occurredAt: { gt: since },
          OR: [{ kind: 'CONCORRENTE' }, { severity: 'CRITICAL' }],
          ...(cuts.rtvUserId ? { rtvUserId: cuts.rtvUserId } : {}),
          ...(cuts.farmId ? { farmId: cuts.farmId } : {}),
          ...(cuts.productKey ? { productKey: cuts.productKey } : {}),
          ...(cuts.region ? { farm: { region: cuts.region } } : {}),
          ...(cuts.crop ? { cropSeason: { crop: cuts.crop } } : {}),
        },
      }),
    ]);
    const changed = [...new Set(after.map((row) => row.conversationId))];
    const before = changed.length
      ? await this.prisma.dealSnapshot.findMany({
          where: {
            tenantId,
            conversationId: { in: changed },
            occurredAt: { lte: since },
          },
          orderBy: { occurredAt: 'desc' },
          distinct: ['conversationId'],
          select: { conversationId: true, occurredAt: true, stage: true, temperature: true },
        })
      : [];
    return buildSince({
      since,
      interventions: interventions.map(toStored),
      snapshots: [...before, ...after].map((row) => ({
        conversationId: row.conversationId,
        occurredAt: row.occurredAt,
        stage: row.stage,
        temperature: asTemperature(row.temperature),
      })),
      threats,
    });
  }

  private presentOutcome(
    rows: InterventionRow[],
    deals: DealRow[],
    window: TimeWindow,
    since: ReturnType<typeof buildSince> | null,
    unknownPending: number,
  ) {
    const dealById = new Map(deals.map((deal) => [deal.conversationId, deal] as const));
    const cards = rows
      .map((row) => toOutcomeCard(row, dealById.get(row.conversationId)))
      .filter((card): card is OutcomeCard => card != null);
    const board = buildScoreboard(rows.map(toStored), window);
    const pack = (list: StoredIntervention[]) => {
      const ids = new Set(list.map((row) => row.id));
      return { count: list.length, items: cards.filter((card) => ids.has(card.id)).slice(0, 30) };
    };
    return {
      confidence: {
        stale: deals.filter((deal) => deal.analysisQuality === 'STALE').length,
        partial: deals.filter((deal) => deal.analysisQuality === 'PARTIAL').length,
        unknownPending,
      },
      scoreboard: {
        asked: pack(board.asked),
        decided: pack(board.decided),
        observed: pack(board.observed),
        moved: pack(board.moved),
        expired: pack(board.expired),
        medianReactionHours:
          board.medianReactionHours == null
            ? null
            : Math.round(board.medianReactionHours * 10) / 10,
        partialInMoved: board.partialInMoved,
      },
      queue: cards
        .filter((card) => (card.status === 'OPEN' || card.status === 'ACKNOWLEDGED') && !card.stale)
        .sort(sortQueue)
        .slice(0, 30),
      since,
    };
  }

  private async loadPortfolio(
    tenantId: string,
    facts: FactRow[],
    deals: DealRow[],
    cuts: DashboardCuts,
    window: TimeWindow,
    now: Date,
  ) {
    const opportunities = buildOpportunities(facts, window);
    const competitive = buildCompetitive(
      facts,
      new Map(deals.map((deal) => [deal.conversationId, deal.stage] as const)),
      window,
    );
    if (cuts.rtvUserId || cuts.productKey) {
      return {
        silentFarms: [],
        silentFarmsNote:
          'Filtro de RTV ou produto não recorta a carteira: a fazenda não tem responsável atribuído.',
        opportunities,
        competitive,
      };
    }
    const farms = await this.prisma.farm.findMany({
      where: {
        tenantId,
        ...(cuts.farmId ? { id: cuts.farmId } : {}),
        ...(cuts.region ? { region: cuts.region } : {}),
      },
      take: 500,
      select: {
        id: true,
        name: true,
        region: true,
        areaHa: true,
        producer: { select: { name: true } },
        cropSeasons: {
          where: cuts.crop ? { crop: cuts.crop } : undefined,
          select: { crop: true, seasonLabel: true, areaHa: true },
        },
        facts: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
      },
    });
    const inputs: SilentFarmInput[] = [];
    for (const farm of farms) {
      const lastFactAt = farm.facts[0]?.occurredAt ?? null;
      const farmArea = farm.areaHa == null ? null : Number(farm.areaHa);
      if (!farm.cropSeasons.length) {
        if (cuts.crop) continue;
        inputs.push({
          farmId: farm.id,
          farmName: farm.name,
          producerName: farm.producer.name,
          region: farm.region,
          crop: null,
          seasonLabel: null,
          areaHa: farmArea,
          lastFactAt,
        });
        continue;
      }
      for (const season of farm.cropSeasons) {
        inputs.push({
          farmId: farm.id,
          farmName: farm.name,
          producerName: farm.producer.name,
          region: farm.region,
          crop: season.crop,
          seasonLabel: season.seasonLabel,
          areaHa: season.areaHa == null ? farmArea : Number(season.areaHa),
          lastFactAt,
        });
      }
    }
    return {
      silentFarms: buildSilentFarms(inputs, window.from, now),
      silentFarmsNote: null as string | null,
      opportunities,
      competitive,
    };
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

type InterventionRow = Prisma.ManagerInterventionGetPayload<Record<string, never>>;

export interface OutcomeCard {
  id: string;
  conversationId: string;
  producerName: string | null;
  farmNames: string[];
  rtvUserId: string | null;
  rtvName: string | null;
  trigger: InterventionTrigger;
  status: InterventionStatus;
  decision: InterventionDecision | null;
  stage: DealStage;
  temperature: DealTemperature;
  analysisQuality: AnalysisQuality;
  uncertain: boolean;
  stale: boolean;
  blockerSubtype: string | null;
  recommendedAction: string;
  recommendedOwner: 'RTV' | 'MANAGER';
  dueAt: string | null;
  managerGuidance: string | null;
  moneyHints: string[];
  movement: InterventionMovement | null;
  movementNote: string | null;
  executionObservedAt: string | null;
  producerRepliedAt: string | null;
  executionChannel: string | null;
  createdAt: string;
  canDelegate: boolean;
}

const TRIGGER_RANK: Record<InterventionTrigger, number> = {
  PRICE_OVER_AUTHORITY: 0,
  ESCALATE: 1,
  COOLING_CLOSE: 2,
  COMPETITOR_LATE: 3,
  MANAGER_OWNER: 4,
};

function asTemperature(value: string): DealTemperature {
  if (value === 'HOT' || value === 'WARM' || value === 'COOLING' || value === 'COLD') return value;
  return 'WARM';
}

function asHints(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function groupFacts(facts: FactRow[]) {
  const grouped = new Map<string, FactRow[]>();
  for (const fact of facts) {
    const list = grouped.get(fact.conversationId);
    if (list) list.push(fact);
    else grouped.set(fact.conversationId, [fact]);
  }
  return grouped;
}

function toCandidate(
  deal: DealRow,
  facts: FactRow[],
  openSignal: { competitor: boolean; hints: string[] } | undefined,
  authorityPct: number | null,
  now: Date,
) {
  const moneyHints = [...new Set([...deal.moneyHints, ...(openSignal?.hints ?? [])])];
  return {
    conversationId: deal.conversationId,
    stage: deal.stage,
    temperature: dealTemperature(
      {
        stage: deal.stage,
        intent: deal.intent,
        urgency: deal.urgency,
        lastMessageAt: deal.lastMessageAt,
        lastDirection: deal.lastDirection,
      },
      now,
    ),
    intent: deal.intent,
    urgency: deal.urgency,
    stageConfidence: deal.stageConfidence,
    analysisQuality: deal.analysisQuality,
    blockerSubtype: deal.blockerSubtype,
    recommendedAction: deal.nextAction,
    recommendedKind: deal.nextActionKind,
    recommendedOwner: deal.nextActionOwner,
    dueAt: deal.nextActionDueAt,
    managerGuidance: deal.managerGuidance,
    moneyHints,
    evidenceMessageId: deal.evidenceMessageId,
    rtvUserId: deal.rtvUserId,
    hasCompetitor:
      Boolean(openSignal?.competitor) || facts.some((fact) => fact.kind === 'CONCORRENTE'),
    discountPct: hintedDiscountPct(moneyHints),
    authorityPct,
  };
}

function toStored(row: InterventionRow): StoredIntervention {
  return {
    id: row.id,
    conversationId: row.conversationId,
    trigger: row.trigger,
    status: row.status,
    decision: row.decision,
    evidenceMessageId: row.evidenceMessageId,
    stage: row.stage,
    temperature: asTemperature(row.temperature),
    blockerSubtype: row.blockerSubtype,
    analysisQuality: row.analysisQuality,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    executionObservedAt: row.executionObservedAt,
    expiredAt: row.expiredAt,
    movement: row.movement,
    movementAt: row.movementAt,
    rtvUserId: row.rtvUserId,
  };
}

function toOutcomeCard(row: InterventionRow, deal: DealRow | undefined): OutcomeCard | null {
  if (!deal) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    producerName: deal.producerName,
    farmNames: deal.farmNames,
    rtvUserId: row.rtvUserId,
    rtvName: deal.rtvName,
    trigger: row.trigger,
    status: row.status,
    decision: row.decision,
    stage: row.stage,
    temperature: asTemperature(row.temperature),
    analysisQuality: row.analysisQuality,
    uncertain: row.analysisQuality !== 'COMPLETE' || deal.analysisQuality !== 'COMPLETE',
    stale: deal.analysisQuality === 'STALE',
    blockerSubtype: row.blockerSubtype,
    recommendedAction: row.recommendedAction,
    recommendedOwner: row.recommendedOwner,
    dueAt: row.dueAt?.toISOString() ?? null,
    managerGuidance: row.managerGuidance,
    moneyHints: asHints(row.moneyHints),
    movement: row.movement,
    movementNote: row.movementNote,
    executionObservedAt: row.executionObservedAt?.toISOString() ?? null,
    producerRepliedAt: row.producerRepliedAt?.toISOString() ?? null,
    executionChannel: row.executionChannel,
    createdAt: row.createdAt.toISOString(),
    canDelegate: Boolean(row.rtvUserId) && row.status === 'OPEN',
  };
}

function sortQueue(a: OutcomeCard, b: OutcomeCard): number {
  const trigger = TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger];
  if (trigger !== 0) return trigger;
  const temperature = TEMPERATURE_ORDER[a.temperature] - TEMPERATURE_ORDER[b.temperature];
  if (temperature !== 0) return temperature;
  const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  return aDue - bDue;
}
