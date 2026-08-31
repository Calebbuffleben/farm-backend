import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type ChannelKind,
  type MessageDirection,
  type MessageType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisStreamService } from '../waba/redis-stream.service';
import { ConsentService } from '../consent/consent.service';
import { OpsService } from '../ops/ops.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

/**
 * Inatividade que fecha a LogicalSession e abre outra (grão de contexto do LLM).
 * TOPIC_SHIFT existe no enum mas não é setado no ano 1 — não há classificador
 * de assunto. O corte é só INACTIVITY: no próximo ingest e no job abaixo.
 */
export const SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000;
const SESSION_REAP_MS = 60_000;

/** Regra pura de rollover — exportada para teste unitário. */
export function shouldRollSession(
  lastMessageAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!lastMessageAt) return false;
  return now.getTime() - lastMessageAt.getTime() > SESSION_INACTIVITY_MS;
}

export type NormalizedInbound = {
  tenantId: string;
  endpointId: string;
  peerAddress: string;
  /** Vira Message.wamid (prefixo por canal: wamid: / twilio: / email:) */
  externalId: string;
  direction: MessageDirection;
  type: MessageType;
  body?: string | null;
  sentAt: Date;
  mediaRef?: Prisma.JsonObject;
  /** EMAIL: assunto da primeira mensagem da thread (denormalizado). */
  subject?: string | null;
};

const CONSENT_SOURCE: Record<ChannelKind, string> = {
  WABA: 'waba_first_contact',
  VOICE: 'voice_first_contact',
  EMAIL: 'email_first_contact',
};

/**
 * Núcleo de ingestão compartilhado por WABA / voz / e-mail.
 * Adapters só mapeiam o payload do vendor para NormalizedInbound.
 */
@Injectable()
export class CoreIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreIngestService.name);
  private reapTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: RedisStreamService,
    private readonly consent: ConsentService,
    private readonly ops: OpsService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  onModuleInit() {
    this.reapTimer = setInterval(() => void this.closeStaleSessions(), SESSION_REAP_MS);
    void this.closeStaleSessions();
  }

  onModuleDestroy() {
    if (this.reapTimer) clearInterval(this.reapTimer);
  }

  /** Fecha sessões cuja conversa está quieta há >24h (endedAt fica preenchido). */
  async closeStaleSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - SESSION_INACTIVITY_MS);
    return this.tenantCtx.runWithTenantBypass(async () => {
      const stale = await this.prisma.logicalSession.findMany({
        where: {
          endedAt: null,
          OR: [
            { conversation: { lastMessageAt: { lte: cutoff } } },
            {
              conversation: { lastMessageAt: null },
              startedAt: { lte: cutoff },
            },
          ],
        },
        select: {
          id: true,
          conversation: { select: { lastMessageAt: true } },
        },
        take: 50,
      });
      for (const row of stale) {
        await this.prisma.logicalSession.update({
          where: { id: row.id },
          data: {
            endedAt: row.conversation.lastMessageAt ?? cutoff,
            closeReason: 'INACTIVITY',
          },
        });
      }
      if (stale.length) {
        this.logger.log(`logical sessions closed by inactivity: ${stale.length}`);
      }
      return stale.length;
    });
  }

  async ingest(n: NormalizedInbound): Promise<void> {
    // Webhook/voz/e-mail são @Public — sem ALS de tenant. Queries passam
    // tenantId explícito; bypass só libera o middleware fail-closed.
    return this.tenantCtx.runWithTenantBypass(() => this.ingestInner(n));
  }

  private async ingestInner(n: NormalizedInbound): Promise<void> {
    const endpoint = await this.prisma.channelEndpoint.findUnique({
      where: { id: n.endpointId },
      include: { channelAccount: { select: { kind: true } } },
    });
    if (!endpoint || endpoint.tenantId !== n.tenantId) {
      this.logger.warn(`ingest skip: unknown endpoint ${n.endpointId}`);
      return;
    }
    const kind = endpoint.channelAccount.kind;

    if (await this.alreadyIngested(n.tenantId, n.externalId)) {
      this.logger.debug(`duplicate externalId ignored: ${n.externalId}`);
      return;
    }

    const producerId = await this.resolveProducer(
      n.tenantId,
      kind,
      n.peerAddress,
    );
    await this.consent.ensureFirstContact(
      n.tenantId,
      producerId,
      CONSENT_SOURCE[kind],
    );

    const phoneAlias = kind === 'EMAIL' ? null : n.peerAddress;
    const conversation = await this.prisma.conversation.upsert({
      where: {
        channelEndpointId_peerAddress: {
          channelEndpointId: n.endpointId,
          peerAddress: n.peerAddress,
        },
      },
      create: {
        tenantId: n.tenantId,
        channelEndpointId: n.endpointId,
        peerAddress: n.peerAddress,
        wabaNumberId: endpoint.wabaNumberId,
        producerPhone: phoneAlias,
        producerId,
        emailSubject: kind === 'EMAIL' ? (n.subject ?? null) : null,
      },
      update: { tenantId: n.tenantId, ...(producerId ? { producerId } : {}) },
    });

    if (
      kind === 'EMAIL' &&
      n.subject &&
      !conversation.emailSubject
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { emailSubject: n.subject },
      });
      conversation.emailSubject = n.subject;
    }

    const session = await this.resolveSession(
      n.tenantId,
      conversation.id,
      conversation.lastMessageAt,
      n.sentAt,
    );

    const pendingMedia = Boolean(n.mediaRef);
    try {
      const created = await this.prisma.message.create({
        data: {
          tenantId: n.tenantId,
          conversationId: conversation.id,
          sessionId: session.id,
          wamid: n.externalId,
          direction: n.direction,
          type: n.type,
          body: n.body ?? null,
          mediaStatus: pendingMedia ? 'PENDING_MEDIA' : 'NONE',
          mediaRef: n.mediaRef ?? Prisma.JsonNull,
          sentAt: n.sentAt,
        },
      });

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: n.sentAt, status: 'OPEN' },
      });

      if (n.type === 'TEXT' && (await this.consent.canAnalyze(n.tenantId, producerId))) {
        await this.stream.publishMessageReady({
          messageId: created.id,
          tenantId: n.tenantId,
          conversationId: conversation.id,
          sessionId: session.id,
          type: n.type,
        });
      }
      this.ops.record({
        service: 'farm-backend',
        stage: 'channel.ingest.ok',
        message: n.externalId,
        tenantId: n.tenantId,
        conversationId: conversation.id,
        messageId: created.id,
        metadata: { kind },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`duplicate externalId ignored: ${n.externalId}`);
        return;
      }
      throw err;
    }
  }

  async resolveSession(
    tenantId: string,
    conversationId: string,
    lastMessageAt: Date | null,
    now: Date,
  ): Promise<{ id: string }> {
    const open = await this.prisma.logicalSession.findFirst({
      where: { tenantId, conversationId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (open && !shouldRollSession(lastMessageAt, now)) {
      return open;
    }
    if (open) {
      await this.prisma.logicalSession.update({
        where: { id: open.id },
        data: { endedAt: lastMessageAt ?? now, closeReason: 'INACTIVITY' },
      });
    }
    return this.prisma.logicalSession.create({
      data: { tenantId, conversationId, startedAt: now },
    });
  }

  /** Cutover WABA: mensagens antigas ficaram sem o prefixo `wamid:`. */
  private async alreadyIngested(
    tenantId: string,
    externalId: string,
  ): Promise<boolean> {
    const ids = [externalId];
    if (externalId.startsWith('wamid:')) ids.push(externalId.slice(6));
    const found = await this.prisma.message.findFirst({
      where: { tenantId, wamid: { in: ids } },
      select: { id: true },
    });
    return Boolean(found);
  }

  private async resolveProducer(
    tenantId: string,
    kind: ChannelKind,
    peerAddress: string,
  ): Promise<string | null> {
    if (kind === 'EMAIL') {
      const row = await this.prisma.producerEmail.findUnique({
        where: { tenantId_email: { tenantId, email: peerAddress } },
      });
      return row?.producerId ?? null;
    }
    const row = await this.prisma.producerPhone.findUnique({
      where: { tenantId_phone: { tenantId, phone: peerAddress } },
    });
    return row?.producerId ?? null;
  }
}
