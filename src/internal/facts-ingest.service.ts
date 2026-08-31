import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { PublishAnalysisDto } from './dto/analysis.dto';
import { ConsentService } from '../consent/consent.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

/**
 * Aplica o resultado da análise do worker (farm/intelligence) sobre uma
 * mensagem. Reprocessamento é idempotente: apaga o material LLM anterior da
 * mensagem (links source=LLM, fatos, unknowns PENDING) e recria — vínculos
 * HUMAN nunca são tocados.
 */
@Injectable()
export class FactsIngestService {
  private readonly logger = new Logger(FactsIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async applyAnalysis(messageId: string, dto: PublishAnalysisDto) {
    // Worker interno é @Public — sem ALS de tenant. Igual ao CoreIngest.
    return this.tenantCtx.runWithTenantBypass(() =>
      this.applyAnalysisInner(messageId, dto),
    );
  }

  /** ChannelEndpoint.assignedUserId is the source; WabaNumber is alias. */
  private async assignedRtvUserId(conversation: {
    wabaNumber?: { assignedUserId: string | null } | null;
  }): Promise<string | null> {
    const endpointId = (conversation as { channelEndpointId?: string })
      .channelEndpointId;
    if (!endpointId) return null;
    const endpoints = (
      this.prisma as unknown as {
        channelEndpoint: {
          findUnique: (args: {
            where: { id: string };
            select: { assignedUserId: true };
          }) => Promise<{ assignedUserId: string | null } | null>;
        };
      }
    ).channelEndpoint;
    const row = await endpoints.findUnique({
      where: { id: endpointId },
      select: { assignedUserId: true },
    });
    return row?.assignedUserId ?? null;
  }

  private async applyAnalysisInner(
    messageId: string,
    dto: PublishAnalysisDto,
  ) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: {
          include: { wabaNumber: { select: { assignedUserId: true } } },
        },
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    const tenantId = message.tenantId;
    const producerId = message.conversation.producerId;
    const rtvUserId =
      (await this.assignedRtvUserId(message.conversation)) ??
      message.conversation.wabaNumber?.assignedUserId ??
      null;

    if (!(await this.consent.canAnalyze(tenantId, producerId))) {
      this.logger.log(`analysis skipped (consent) message=${messageId}`);
      return { ok: true, skipped: 'consent_revoked', facts: 0, links: 0 };
    }

    const farmIds = new Set<string>();
    for (const link of dto.links) farmIds.add(link.farmId);
    for (const fact of dto.facts) if (fact.farmId) farmIds.add(fact.farmId);

    await this.prisma.$transaction(async (tx) => {
      const messagePatch: {
        transcript?: string | null;
        transcriptConfidence?: number | null;
        coachNote?: string | null;
        coachTone?: string | null;
      } = {};
      if (dto.transcript !== undefined) {
        messagePatch.transcript = dto.transcript;
        messagePatch.transcriptConfidence = dto.transcriptConfidence ?? null;
      }
      if (dto.coachNote !== undefined) {
        messagePatch.coachNote = dto.coachNote;
        messagePatch.coachTone = dto.coachTone ?? null;
      }
      if (Object.keys(messagePatch).length) {
        await tx.message.update({
          where: { id: messageId },
          data: messagePatch,
        });
      }

      // idempotência de reprocessamento
      await tx.entityLink.deleteMany({
        where: { tenantId, messageId, source: 'LLM' },
      });
      await tx.commercialFact.deleteMany({
        where: { tenantId, evidenceMessageId: messageId },
      });
      await tx.unknownQueueItem.deleteMany({
        where: { tenantId, messageId, status: 'PENDING' },
      });

      if (dto.links.length) {
        await tx.entityLink.createMany({
          data: dto.links.map((link) => ({
            tenantId,
            messageId,
            farmId: link.farmId,
            cropSeasonId: link.cropSeasonId ?? null,
            spanText: link.spanText ?? null,
            confidence: link.confidence,
            source: 'LLM' as const,
          })),
        });
      }

      if (dto.facts.length) {
        await tx.commercialFact.createMany({
          data: dto.facts.map((fact) => ({
            tenantId,
            kind: fact.kind,
            subtype: fact.subtype,
            severity: fact.severity,
            confidence: fact.confidence,
            farmId: fact.farmId ?? null,
            producerId,
            cropSeasonId: fact.cropSeasonId ?? null,
            rtvUserId,
            productKey: fact.productKey ?? null,
            headline: fact.headline,
            moneyHint: fact.moneyHint ?? null,
            dueHintText: fact.dueHintText ?? null,
            dueAt: fact.dueAt ? new Date(fact.dueAt) : null,
            evidenceMessageId: messageId,
            evidenceSpan: fact.evidenceSpan ?? null,
            occurredAt: message.sentAt,
          })),
        });
      }

      if (dto.unknowns.length) {
        await tx.unknownQueueItem.createMany({
          data: dto.unknowns.map((unknown) => ({
            tenantId,
            messageId,
            spanText: unknown.spanText ?? null,
            candidates: unknown.candidates as unknown as Prisma.JsonArray,
          })),
        });
      }

      if (dto.sessionSummary && message.sessionId) {
        await tx.logicalSession.update({
          where: { id: message.sessionId },
          data: { summary: dto.sessionSummary },
        });
      }
    });

    for (const farmId of farmIds) {
      await this.refreshFarmState(tenantId, farmId);
    }

    this.logger.log(
      `analysis applied message=${messageId} facts=${dto.facts.length} links=${dto.links.length} unknowns=${dto.unknowns.length}`,
    );
    return { ok: true, facts: dto.facts.length, links: dto.links.length };
  }

  /** Materializa o snapshot de fatos abertos da fazenda (card do dashboard). */
  async refreshFarmState(tenantId: string, farmId: string): Promise<void> {
    return this.tenantCtx.runWithTenantBypass(() =>
      this.refreshFarmStateInner(tenantId, farmId),
    );
  }

  private async refreshFarmStateInner(
    tenantId: string,
    farmId: string,
  ): Promise<void> {
    const openFacts = await this.prisma.commercialFact.findMany({
      where: { tenantId, farmId, status: 'OPEN' },
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: {
        id: true,
        kind: true,
        subtype: true,
        severity: true,
        headline: true,
        productKey: true,
        moneyHint: true,
        dueAt: true,
        occurredAt: true,
      },
    });
    const lastFactAt = openFacts[0]?.occurredAt ?? null;
    await this.prisma.farmState.upsert({
      where: { farmId },
      create: {
        tenantId,
        farmId,
        openFacts: openFacts as unknown as Prisma.JsonArray,
        lastFactAt,
      },
      update: {
        tenantId,
        openFacts: openFacts as unknown as Prisma.JsonArray,
        lastFactAt,
      },
    });
  }
}
