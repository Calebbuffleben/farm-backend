import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CoreIngestService } from '../channel/core-ingest.service';
import { RedisStreamService } from '../waba/redis-stream.service';
import { OpsService } from '../ops/ops.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { WaSessionService } from './wa-session.service';
import {
  composeReport,
  dayKey,
  inBusinessHours,
  jitterMs,
  nextBusinessSlot,
  reportEligibility,
  REPORT_ELIGIBLE_WINDOW_MS,
} from './outbound-policy';

const QUEUE_KEY = 'farm:wa-out:queue';
const TICK_MS = 5_000;
const CRON_CHECK_MS = 10 * 60_000;
const CRON_HOUR_BRT = 9;
const ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

interface ReportJob {
  kind: 'report';
  tenantId: string;
  conversationId: string;
  accountId: string;
  requestedBy: string | null;
}

/**
 * Fila de relatório no WhatsApp do RTV. Redis sorted set (score = quando
 * enviar). Sem BullMQ: um loop, um ZRANGE, um ZREM. Delay 15–45s entre jobs
 * da mesma linha, "digitando" antes do texto, só horário comercial, e para
 * sozinha se a sessão cair (isReady). Sem Redis a fila fica desligada — o
 * botão "Enviar relatório" ainda funciona porque envia na hora.
 */
@Injectable()
export class OutboundQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundQueue.name);
  private timer: NodeJS.Timeout | undefined;
  private cronTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
    private readonly stream: RedisStreamService,
    private readonly ops: OpsService,
    private readonly tenantCtx: TenantContextService,
    private readonly sessions: WaSessionService,
  ) {}

  onModuleInit() {
    if (process.env.WA_REPORT_QUEUE_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.cronTimer = setInterval(() => void this.dailyCron(), CRON_CHECK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.cronTimer) clearInterval(this.cronTimer);
  }

  // ---------- API usada pelo controller ----------

  async eligibility(user: TenantContext, conversationId: string) {
    const c = await this.loadConversation(user, conversationId);
    return this.eligibilityOf(c);
  }

  /** Botão "Enviar relatório": enfileira (ou envia na hora sem Redis). */
  async enqueueReport(user: TenantContext, conversationId: string) {
    if (!ADMIN_ROLES.has(user.role)) throw new ForbiddenException('Só gestor envia relatório');
    const c = await this.loadConversation(user, conversationId);
    const elig = await this.eligibilityOf(c);
    if (!elig.eligible) throw new BadRequestException(`Não elegível: ${elig.reason}`);
    const job: ReportJob = {
      kind: 'report',
      tenantId: c.tenantId,
      conversationId: c.id,
      accountId: c.channelEndpoint.channelAccountId,
      requestedBy: user.userId,
    };
    const redis = this.stream.redis;
    if (!redis) {
      await this.tenantCtx.runWithTenantBypass(() => this.runReport(job));
      return { queued: false as const, scheduledFor: new Date().toISOString() };
    }
    const at = await this.schedule(job);
    return { queued: true as const, scheduledFor: at.toISOString() };
  }

  // ---------- fila ----------

  /** Próximo horário comercial + jitter acumulado por linha. */
  private async schedule(job: ReportJob): Promise<Date> {
    const redis = this.stream.redis!;
    const now = Date.now();
    const base = nextBusinessSlot(new Date(now)).getTime();
    const nextKey = `farm:wa-out:next:${job.accountId}`;
    const prev = Number((await redis.get(nextKey)) ?? 0);
    const at = Math.max(base, prev) + jitterMs();
    await redis.set(nextKey, String(at), { EX: 24 * 3600 });
    await redis.zAdd(QUEUE_KEY, { score: at, value: JSON.stringify(job) });
    return new Date(at);
  }

  private async tick(): Promise<void> {
    const redis = this.stream.redis;
    if (!redis || this.running) return;
    this.running = true;
    try {
      const due = await redis.zRangeByScore(QUEUE_KEY, 0, Date.now(), { LIMIT: { offset: 0, count: 1 } });
      for (const raw of due) {
        if ((await redis.zRem(QUEUE_KEY, raw)) !== 1) continue; // outro pod pegou
        const job = JSON.parse(raw) as ReportJob;
        if (!inBusinessHours(new Date())) {
          await this.schedule(job);
          continue;
        }
        await this.tenantCtx.runWithTenantBypass(() => this.runReport(job)).catch((err: Error) => {
          this.logger.warn(`report job failed conversation=${job.conversationId}: ${err.message}`);
          this.ops.record({
            service: 'farm-backend',
            stage: 'wa-session.report.failed',
            message: err.message,
            tenantId: job.tenantId,
            conversationId: job.conversationId,
            severity: 'warning',
          });
        });
      }
    } catch (err) {
      this.logger.error(`tick: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async runReport(job: ReportJob): Promise<void> {
    const c = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, tenantId: job.tenantId },
      include: {
        producer: { select: { id: true, name: true } },
        channelEndpoint: { include: { channelAccount: true } },
      },
    });
    if (!c) return;
    const elig = await this.eligibilityOf(c);
    if (!elig.eligible) {
      this.logger.log(`report skip conversation=${c.id}: ${elig.reason}`);
      return;
    }
    const facts = await this.prisma.commercialFact.findMany({
      where: { tenantId: c.tenantId, producerId: c.producer!.id, status: 'OPEN' },
      orderBy: { occurredAt: 'desc' },
      take: 5,
      select: { headline: true },
    });
    const text = composeReport(c.producer!.name, facts.map((f) => f.headline));
    const outbound = this.sessions.outboundFor(c.channelEndpoint.channelAccount, 'report');
    if (!(await outbound.isReady())) {
      this.logger.warn(`report skip conversation=${c.id}: sessão não está ACTIVE`);
      return;
    }
    const vendorId = await outbound.sendText(c.peerAddress, text, { typingSeconds: 3 + Math.floor(Math.random() * 4) });

    const now = new Date();
    const session = await this.core.resolveSession(c.tenantId, c.id, c.lastMessageAt, now);
    await this.prisma.message.create({
      data: {
        tenantId: c.tenantId,
        conversationId: c.id,
        sessionId: session.id,
        wamid: `evo:${vendorId}`,
        direction: 'OUT',
        type: 'TEXT',
        body: text,
        senderUserId: job.requestedBy,
        sentAt: now,
      },
    });
    await this.prisma.conversation.update({ where: { id: c.id }, data: { lastMessageAt: now } });
    this.ops.record({
      service: 'farm-backend',
      stage: 'wa-session.report.sent',
      message: vendorId,
      tenantId: c.tenantId,
      conversationId: c.id,
      userId: job.requestedBy,
    });
  }

  /** 1x/dia às 09:00 BRT: enfileira todas as conversas elegíveis. */
  private async dailyCron(): Promise<void> {
    const redis = this.stream.redis;
    if (!redis) return;
    const now = new Date();
    if (!inBusinessHours(now)) return;
    const hourBrt = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(now),
    );
    if (hourBrt !== CRON_HOUR_BRT) return;
    const guard = await redis.set(`farm:wa-report:cron:${dayKey(now)}`, '1', { NX: true, EX: 36 * 3600 });
    if (guard !== 'OK') return;

    await this.tenantCtx.runWithTenantBypass(async () => {
      const since = new Date(now.getTime() - REPORT_ELIGIBLE_WINDOW_MS);
      const candidates = await this.prisma.conversation.findMany({
        where: {
          tenantId: { not: '' },
          reportOptOutAt: null,
          producerId: { not: null },
          lastMessageAt: { gte: since },
          channelEndpoint: { channelAccount: { kind: 'WA_SESSION', status: 'ACTIVE' } },
        },
        select: { id: true, tenantId: true, channelEndpoint: { select: { channelAccountId: true } } },
        take: 500,
      });
      let queued = 0;
      for (const c of candidates) {
        const full = await this.prisma.conversation.findFirst({
          where: { id: c.id, tenantId: c.tenantId },
          include: { producer: { select: { id: true, name: true } }, channelEndpoint: { include: { channelAccount: true } } },
        });
        if (!full || !(await this.eligibilityOf(full)).eligible) continue;
        await this.schedule({
          kind: 'report',
          tenantId: c.tenantId,
          conversationId: c.id,
          accountId: c.channelEndpoint.channelAccountId,
          requestedBy: null,
        });
        queued++;
      }
      this.logger.log(`daily report cron queued=${queued}`);
    });
  }

  // ---------- helpers ----------

  private async loadConversation(user: TenantContext, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        tenantId: user.tenantId,
        ...(ADMIN_ROLES.has(user.role) ? {} : { channelEndpoint: { assignedUserId: user.userId } }),
      },
      include: {
        producer: { select: { id: true, name: true } },
        channelEndpoint: { include: { channelAccount: true } },
      },
    });
    if (!c) throw new NotFoundException('Conversa não encontrada');
    return c;
  }

  private async eligibilityOf(c: {
    id: string;
    tenantId: string;
    reportOptOutAt: Date | null;
    producer: { id: string } | null;
    channelEndpoint: { channelAccount: { kind: string; status: string } };
  }) {
    if (c.channelEndpoint.channelAccount.kind !== 'WA_SESSION') {
      return { eligible: false, reason: 'relatório só no WhatsApp do RTV' };
    }
    if (!c.producer) return { eligible: false, reason: 'produtor não identificado (carteira)' };
    const [lastIn, openFacts] = await Promise.all([
      this.prisma.message.findFirst({
        where: { tenantId: c.tenantId, conversationId: c.id, direction: 'IN' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      }),
      this.prisma.commercialFact.count({
        where: { tenantId: c.tenantId, producerId: c.producer.id, status: 'OPEN' },
      }),
    ]);
    return reportEligibility({
      optOutAt: c.reportOptOutAt,
      lastInboundAt: lastIn?.sentAt ?? null,
      openFacts,
      sessionActive: c.channelEndpoint.channelAccount.status === 'ACTIVE',
      now: new Date(),
    });
  }
}
