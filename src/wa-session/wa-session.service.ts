import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { ChannelAccount, ChannelEndpoint } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CoreIngestService } from '../channel/core-ingest.service';
import { RedisStreamService } from '../waba/redis-stream.service';
import { OpsService } from '../ops/ops.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { farmPublicUrl } from '../channel/public-origin';
import { ensureWaSessionEndpoint } from '../channel/wa-session-endpoint';
import type { OutboundKind, WhatsAppOutbound } from '../channel/whatsapp-outbound';
import { encryptSecret } from '../waba/waba-crypto';
import { e164 } from '../voice/twilio-media';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { parseWaSessionCredentials, EvolutionClient, type WaSessionCreds } from './evolution.client';
import { evolutionEvent, evolutionToInbound, type EvolutionWebhook } from './evolution-ingest';
import { dailyCap, dayKey, isOptOutText, rampDay } from './outbound-policy';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);
const DEFAULT_STEADY_CAP = 50;

/**
 * Base que a Evolution (dentro do Docker) usa para bater no Farm. Em dev o
 * backend e a Evolution rodam no host → http://localhost:8080; em produção
 * cai em FARM_PUBLIC_URL.
 */
function webhookBaseUrl(): string | null {
  const own = process.env.WA_SESSION_WEBHOOK_BASE_URL?.replace(/\/$/, '').trim();
  return own || farmPublicUrl();
}

type AccountWithEndpoint = ChannelAccount & { endpoints: ChannelEndpoint[] };

export interface WaSessionState {
  accountId: string;
  endpointId: string;
  status: 'NEVER' | 'PENDING' | 'ACTIVE' | 'DISABLED';
  phone: string | null;
  connectedAt: string | null;
  todaySent: number;
  todayCap: number;
  rampDay: number;
  publicUrl: boolean;
  vendorReady: boolean;
  assignedUser?: { id: string; name: string | null; email: string } | null;
}

/**
 * WhatsApp do RTV via Evolution API auto-hospedada (segundo aparelho). Um
 * ChannelAccount WA_SESSION + uma instância Evolution por RTV; credenciais
 * cifradas; status = PENDING (aguardando pareamento), ACTIVE (conectado),
 * DISABLED (nunca / caiu). Nunca recria instância em loop.
 */
@Injectable()
export class WaSessionService {
  private readonly logger = new Logger(WaSessionService.name);
  /** Fallback do contador diário sem Redis (um processo só). */
  private readonly localCounter = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
    private readonly evolution: EvolutionClient,
    private readonly stream: RedisStreamService,
    private readonly ops: OpsService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ---------- leitura ----------

  /** Só leitura: a conta placeholder nasce no connect/import, não em quem abre a tela. */
  async me(user: TenantContext): Promise<WaSessionState> {
    const account = await this.prisma.channelAccount.findFirst({
      where: {
        tenantId: user.tenantId,
        kind: 'WA_SESSION',
        endpoints: { some: { assignedUserId: user.userId } },
      },
      include: { endpoints: true },
    });
    if (account) return this.toState(account);
    return {
      accountId: '',
      endpointId: '',
      status: 'NEVER',
      phone: null,
      connectedAt: null,
      todaySent: 0,
      todayCap: 0,
      rampDay: 0,
      publicUrl: Boolean(webhookBaseUrl()),
      vendorReady: this.evolution.enabled,
    };
  }

  async listForTenant(user: TenantContext): Promise<WaSessionState[]> {
    const accounts = await this.prisma.channelAccount.findMany({
      // Só quem já provisionou instância; placeholder de import puro fica fora.
      where: { tenantId: user.tenantId, kind: 'WA_SESSION', credentialsEncrypted: { not: null } },
      include: {
        endpoints: {
          include: { assignedUser: { select: { id: true, name: true, email: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      accounts.map(async (a) => ({
        ...(await this.toState(a)),
        assignedUser: a.endpoints[0]?.assignedUser ?? null,
      })),
    );
  }

  private async toState(account: AccountWithEndpoint): Promise<WaSessionState> {
    const creds = this.credsOf(account);
    const connectedAt = creds?.connectedAt ? new Date(creds.connectedAt) : null;
    const now = new Date();
    const endpoint = account.endpoints[0];
    return {
      accountId: account.id,
      endpointId: endpoint?.id ?? '',
      status: creds ? account.status : 'NEVER',
      phone: creds?.phone ?? (endpoint?.address.startsWith('+') ? endpoint.address : null),
      connectedAt: connectedAt?.toISOString() ?? null,
      todaySent: await this.sentToday(account.id, now),
      todayCap: dailyCap(connectedAt, now, this.steadyCap()),
      rampDay: rampDay(connectedAt, now),
      publicUrl: Boolean(webhookBaseUrl()),
      vendorReady: this.evolution.enabled,
    };
  }

  // ---------- conexão ----------

  /**
   * Idempotente: reaproveita a instância do RTV. phone → código de pareamento
   * (celular sozinho); sem phone → QR (laptop). Nunca cria segunda instância.
   */
  async connect(user: TenantContext, input: { phone?: string; accepted: boolean }) {
    if (!input.accepted) {
      throw new BadRequestException('Aceite o aviso sobre a conexão via API Web antes de continuar');
    }
    const endpoint = await ensureWaSessionEndpoint(this.prisma, user.tenantId, user.userId);
    let account = await this.prisma.channelAccount.findFirstOrThrow({
      where: { id: endpoint.channelAccountId, tenantId: user.tenantId },
      include: { endpoints: true },
    });
    let creds = this.credsOf(account);
    if (!creds) {
      creds = await this.provisionInstance(user, account.id);
      account = await this.prisma.channelAccount.findFirstOrThrow({
        where: { id: account.id, tenantId: user.tenantId },
        include: { endpoints: true },
      });
    }

    const status = await this.evolution.status(creds).catch(() => null);
    if (status?.connected) {
      await this.markConnected(account, creds);
      return { ...(await this.me(user)), pairingCode: null, qrBase64: null };
    }

    await this.prisma.channelAccount.update({
      where: { id: account.id },
      data: { status: 'PENDING' },
    });

    const phone = input.phone ? e164(input.phone) : null;
    if (input.phone && !phone) throw new BadRequestException('Número inválido (use +55DDD...)');
    const pairingCode = phone ? await this.evolution.pairingCode(creds, phone) : null;
    const qrBase64 = phone ? null : await this.evolution.qrCodeImage(creds);
    return { ...(await this.me(user)), pairingCode, qrBase64 };
  }

  /** Poll da tela de pareamento: sincroniza status com o vendor. */
  async poll(user: TenantContext, accountId: string, wantQr: boolean) {
    const account = await this.accountForUser(user, accountId);
    const creds = this.credsOf(account);
    if (!creds) return { ...(await this.toState(account)), qrBase64: null };
    const status = await this.evolution.status(creds).catch(() => null);
    if (status?.connected && account.status !== 'ACTIVE') {
      await this.markConnected(account, creds);
    } else if (status && !status.connected && account.status === 'ACTIVE') {
      await this.markDisconnected(account.id, account.tenantId, 'poll');
    }
    const fresh = await this.prisma.channelAccount.findFirstOrThrow({
      where: { id: account.id, tenantId: account.tenantId },
      include: { endpoints: true },
    });
    const qrBase64 =
      wantQr && fresh.status === 'PENDING'
        ? await this.evolution.qrCodeImage(creds).catch(() => null)
        : null;
    return { ...(await this.toState(fresh)), qrBase64 };
  }

  async pairingCode(user: TenantContext, accountId: string, phone: string) {
    const account = await this.accountForUser(user, accountId);
    const creds = this.credsOf(account);
    const num = e164(phone);
    if (!creds || !num) throw new BadRequestException('Conta sem instância ou número inválido');
    return { code: await this.evolution.pairingCode(creds, num) };
  }

  async logout(user: TenantContext, accountId: string) {
    const account = await this.accountForUser(user, accountId);
    const creds = this.credsOf(account);
    if (creds) await this.evolution.disconnect(creds).catch((err: Error) => this.logger.warn(err.message));
    await this.markDisconnected(account.id, account.tenantId, 'logout');
    this.ops.audit({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'wa-session.logout',
      target: account.id,
    });
    return { ok: true as const };
  }

  /** Uma instância Evolution por RTV, criada já com o webhook do Farm. */
  private async provisionInstance(user: TenantContext, accountId: string): Promise<WaSessionCreds> {
    const base = webhookBaseUrl();
    const webhookSecret = randomBytes(16).toString('hex');
    const webhookUrl = base ? `${base}/wa-session/webhook/${accountId}/${webhookSecret}` : null;
    if (!webhookUrl) {
      this.logger.warn('WA_SESSION_WEBHOOK_BASE_URL/FARM_PUBLIC_URL ausentes — Evolution não consegue entregar webhook');
    }
    const instance = await this.evolution.createInstance(
      `farm-${user.tenantId.slice(0, 8)}-${user.userId.slice(0, 8)}`,
      webhookUrl,
    );
    const creds: WaSessionCreds = {
      vendor: 'evolution',
      instanceName: instance.instanceName,
      token: instance.token,
      phone: null,
      connectedAt: null,
    };
    await this.prisma.channelAccount.update({
      where: { id: accountId },
      data: {
        credentialsEncrypted: encryptSecret(JSON.stringify(creds)),
        webhookSecret,
        status: 'PENDING',
      },
    });
    return creds;
  }

  private async markConnected(account: AccountWithEndpoint, creds: WaSessionCreds) {
    const phone = (await this.evolution.devicePhone(creds).catch(() => null)) ?? creds.phone ?? null;
    const next: WaSessionCreds = {
      ...creds,
      phone,
      connectedAt: creds.connectedAt ?? new Date().toISOString(),
    };
    await this.prisma.channelAccount.update({
      where: { id: account.id },
      data: { credentialsEncrypted: encryptSecret(JSON.stringify(next)), status: 'ACTIVE' },
    });
    const endpoint = account.endpoints[0];
    if (endpoint && phone && endpoint.address !== phone) {
      // Identidade da linha = E.164. Se já existe endpoint com esse número na conta, mantém.
      await this.prisma.channelEndpoint
        .update({
          where: { id: endpoint.id },
          data: { address: phone, displayAddress: phone },
        })
        .catch((err: Error) => this.logger.warn(`endpoint address: ${err.message}`));
    }
    this.ops.record({
      service: 'farm-backend',
      stage: 'wa-session.connected',
      message: phone ?? account.id,
      tenantId: account.tenantId,
    });
    await this.ensureMediaWebhook(account, creds);
  }

  private async markDisconnected(accountId: string, tenantId: string, why: string) {
    await this.prisma.channelAccount.update({
      where: { id: accountId },
      data: { status: 'DISABLED' },
    });
    // Fila para sozinha: isReady() passa a devolver false. Sem recriar instância.
    this.ops.record({
      service: 'farm-backend',
      stage: 'wa-session.disconnected',
      message: why,
      tenantId,
      severity: 'warning',
      metadata: { accountId },
    });
  }

  // ---------- webhook ----------

  async handleWebhook(accountId: string, secret: string, payload: EvolutionWebhook): Promise<void> {
    await this.tenantCtx.runWithTenantBypass(async () => {
      const account = await this.prisma.channelAccount.findUnique({
        where: { id: accountId },
        include: { endpoints: true },
      });
      if (!account || account.kind !== 'WA_SESSION') {
        this.logger.warn(`wa-session webhook unknown account ${accountId}`);
        return;
      }
      if (!account.webhookSecret || account.webhookSecret !== secret) {
        this.logger.warn(`wa-session webhook bad secret account=${accountId}`);
        return;
      }
      const creds = this.credsOf(account);
      // Segunda verificação: a Evolution manda o token da instância no payload.
      if (creds && payload.apikey && payload.apikey !== creds.token) {
        this.logger.warn(`wa-session webhook apikey mismatch account=${accountId}`);
        return;
      }
      switch (evolutionEvent(payload)) {
        case 'connected':
          if (creds) await this.markConnected(account, creds);
          return;
        case 'disconnected':
          if (account.status === 'ACTIVE') {
            await this.markDisconnected(account.id, account.tenantId, 'webhook');
          }
          return;
        case 'message': {
          const endpoint = account.endpoints[0];
          if (!endpoint) return;
          const n = evolutionToInbound(payload, { tenantId: account.tenantId, endpointId: endpoint.id });
          if (!n) return;
          await this.core.ingest(n);
          if (
            creds &&
            n.type === 'AUDIO' &&
            !(n.mediaRef as { inlineBase64?: string } | undefined)?.inlineBase64
          ) {
            await this.ensureMediaWebhook(account, creds);
          }
          if (n.direction === 'IN' && n.type === 'TEXT' && isOptOutText(n.body)) {
            await this.prisma.conversation.updateMany({
              where: {
                tenantId: account.tenantId,
                channelEndpointId: endpoint.id,
                peerAddress: n.peerAddress,
                reportOptOutAt: null,
              },
              data: { reportOptOutAt: new Date() },
            });
          }
          return;
        }
        default:
          return;
      }
    });
  }

  /** Liga `base64: true` no webhook da instância (STT sem getBase64). */
  private async ensureMediaWebhook(
    account: ChannelAccount,
    creds: WaSessionCreds,
  ): Promise<void> {
    const base = webhookBaseUrl();
    if (!base || !account.webhookSecret) return;
    const url = `${base}/wa-session/webhook/${account.id}/${account.webhookSecret}`;
    await this.evolution.setWebhook(creds, url).catch((err: Error) =>
      this.logger.warn(`setWebhook: ${err.message}`),
    );
  }

  // ---------- outbound (porta) ----------

  /** Porta usada por Inbox e fila. Gate: sessão ACTIVE + teto/rampa do dia. */
  outboundFor(account: ChannelAccount, kind: OutboundKind): WhatsAppOutbound {
    const creds = this.credsOf(account);
    return {
      isReady: async () => {
        if (!creds || account.status !== 'ACTIVE') return false;
        return true;
      },
      sendText: async (to, text, opts) => {
        if (!creds) throw new ForbiddenException('WhatsApp do RTV não conectado');
        if (account.status !== 'ACTIVE') {
          throw new ForbiddenException('WhatsApp do RTV desconectado. Reconecte em Configurações.');
        }
        await this.consumeQuota(account.id, creds, kind);
        return this.evolution.sendText(creds, to, text, opts?.typingSeconds ?? 0);
      },
    };
  }

  /** Rampa 5/15/30 + teto. Inbox humano também conta (não furar rampa). */
  private async consumeQuota(accountId: string, creds: WaSessionCreds, kind: OutboundKind) {
    const now = new Date();
    const connectedAt = creds.connectedAt ? new Date(creds.connectedAt) : null;
    const cap = dailyCap(connectedAt, now, this.steadyCap());
    const used = await this.incrToday(accountId, now);
    if (used > cap) {
      await this.incrToday(accountId, now, -1);
      const day = rampDay(connectedAt, now);
      throw new ForbiddenException(
        `Limite de envios de hoje atingido (dia ${day}: ${cap}). Volta amanhã.` +
          (kind === 'inbox' ? ' Responda pelo WhatsApp do celular.' : ''),
      );
    }
  }

  private counterKey(accountId: string, now: Date) {
    return `farm:wa-out:${accountId}:${dayKey(now)}`;
  }

  private async incrToday(accountId: string, now: Date, by = 1): Promise<number> {
    const key = this.counterKey(accountId, now);
    const redis = this.stream.redis;
    if (redis) {
      const v = await redis.incrBy(key, by);
      if (v === by) await redis.expire(key, 2 * 24 * 3600);
      return v;
    }
    const v = (this.localCounter.get(key) ?? 0) + by;
    this.localCounter.set(key, v);
    return v;
  }

  private async sentToday(accountId: string, now: Date): Promise<number> {
    const key = this.counterKey(accountId, now);
    const redis = this.stream.redis;
    if (redis) return Number((await redis.get(key)) ?? 0);
    return this.localCounter.get(key) ?? 0;
  }

  private steadyCap(): number {
    const n = Number(process.env.WA_SESSION_DAILY_CAP);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STEADY_CAP;
  }

  // ---------- helpers ----------

  credsOf(account: { credentialsEncrypted: string | null }): WaSessionCreds | null {
    try {
      return parseWaSessionCredentials(account.credentialsEncrypted);
    } catch (err) {
      this.logger.warn(`wa-session creds unreadable: ${(err as Error).message}`);
      return null;
    }
  }

  private async accountForUser(user: TenantContext, accountId: string): Promise<AccountWithEndpoint> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId, kind: 'WA_SESSION' },
      include: { endpoints: true },
    });
    if (!account) throw new NotFoundException('WhatsApp não encontrado');
    const own = account.endpoints.some((e) => e.assignedUserId === user.userId);
    if (!own && !ADMIN_ROLES.has(user.role)) throw new ForbiddenException();
    return account;
  }
}
