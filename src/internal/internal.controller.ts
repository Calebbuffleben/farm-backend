import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../waba/storage.service';
import { InternalGuard } from './internal.guard';
import { FactsIngestService } from './facts-ingest.service';
import { PublishAnalysisDto } from './dto/analysis.dto';
import { ConsentService } from '../consent/consent.service';

/**
 * API interna consumida pelo worker Python (farm/intelligence).
 * @Public() tira do JwtAuthGuard global; o InternalGuard exige o shared
 * secret INTERNAL_API_TOKEN — nunca expor este prefixo na borda pública.
 */
@Public()
@UseGuards(InternalGuard)
@SkipThrottle()
@Controller('internal')
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly factsIngest: FactsIngestService,
    private readonly consent: ConsentService,
  ) {}

  /**
   * Contexto completo para o extrator: mensagem, sessão corrente, carteira do
   * produtor (fazendas + safras) e resumos das sessões anteriores — a resposta
   * ao problema da "conversa infinita": o LLM nunca recebe o histórico bruto.
   */
  @Get('messages/:id/context')
  async getContext(@Param('id') messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        mediaAsset: { select: { id: true, contentType: true } },
        conversation: {
          include: {
            producer: { select: { id: true, name: true } },
            channelEndpoint: {
              select: { id: true, displayAddress: true, assignedUserId: true },
            },
            wabaNumber: {
              select: { id: true, displayNumber: true, assignedUserId: true },
            },
          },
        },
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    const tenantId = message.tenantId;

    const sessionMessages = message.sessionId
      ? await this.prisma.message.findMany({
          where: { tenantId, sessionId: message.sessionId },
          orderBy: { sentAt: 'asc' },
          select: {
            id: true,
            direction: true,
            type: true,
            body: true,
            transcript: true,
            sentAt: true,
          },
        })
      : [];

    const previousSummaries = await this.prisma.logicalSession.findMany({
      where: {
        tenantId,
        conversationId: message.conversationId,
        endedAt: { not: null },
      },
      orderBy: { startedAt: 'desc' },
      take: 8,
      select: {
        startedAt: true,
        endedAt: true,
        closeReason: true,
        summary: true,
      },
    });

    const producerId = message.conversation.producerId;
    const farms = producerId
      ? await this.prisma.farm.findMany({
          where: { tenantId, producerId },
          include: {
            cropSeasons: {
              select: {
                id: true,
                crop: true,
                seasonLabel: true,
                areaHa: true,
              },
            },
            state: {
              select: { openFacts: true, lastFactAt: true },
            },
          },
        })
      : [];

    // Vínculos HUMAN da conversa — o LLM não pode sobrescrevê-los; o prompt
    // os recebe como fato confirmado.
    const humanLinks = await this.prisma.entityLink.findMany({
      where: {
        tenantId,
        source: 'HUMAN',
        message: { conversationId: message.conversationId },
      },
      select: {
        farmId: true,
        cropSeasonId: true,
        spanText: true,
        messageId: true,
      },
      take: 50,
    });

    return {
      message: {
        id: message.id,
        tenantId,
        conversationId: message.conversationId,
        sessionId: message.sessionId,
        direction: message.direction,
        type: message.type,
        body: message.body,
        transcript: message.transcript,
        sentAt: message.sentAt,
        mediaAsset: message.mediaAsset,
      },
      conversation: {
        id: message.conversation.id,
        producerPhone:
          message.conversation.producerPhone ??
          message.conversation.peerAddress,
        wabaNumber: message.conversation.wabaNumber ?? {
          id: message.conversation.channelEndpoint.id,
          displayNumber: message.conversation.channelEndpoint.displayAddress,
          assignedUserId: message.conversation.channelEndpoint.assignedUserId,
        },
      },
      producer: message.conversation.producer,
      farms: farms.map((farm) => ({
        id: farm.id,
        name: farm.name,
        region: farm.region,
        areaHa: farm.areaHa,
        cropSeasons: farm.cropSeasons,
        openFacts: farm.state?.openFacts ?? [],
        lastFactAt: farm.state?.lastFactAt ?? null,
      })),
      sessionMessages,
      previousSummaries: previousSummaries.reverse(),
      humanLinks,
      analysisAllowed: await this.consent.canAnalyze(
        tenantId,
        message.conversation.producer?.id,
      ),
    };
  }

  /** Mídia para STT — o worker não precisa de credenciais do object storage. */
  @Get('media/:assetId')
  async streamMedia(
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
    });
    if (!asset) throw new NotFoundException('Media not found');
    const stream = await this.storage.getObjectStream(asset.storageKey);
    res.setHeader('Content-Type', asset.contentType);
    if (asset.sizeBytes) res.setHeader('Content-Length', asset.sizeBytes);
    stream.pipe(res);
  }

  /** Resultado da análise (transcript, links, fatos, unknowns, summary). */
  @Post('messages/:id/analysis')
  async publishAnalysis(
    @Param('id') messageId: string,
    @Body() dto: PublishAnalysisDto,
  ) {
    return this.factsIngest.applyAnalysis(messageId, dto);
  }
}
