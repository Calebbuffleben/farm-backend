import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { WabaCloudFactory } from './waba-cloud';
import { StorageService } from './storage.service';
import { decryptSecret } from './waba-crypto';
import { parseVoiceCredentials, VoiceClient } from '../voice/voice.client';
import { e164 } from '../voice/twilio-media';
import { parseEmailCredentials, EmailClient } from '../email/email.client';
import { emailOutboundSubject } from '../email/mailgun-parse';
import { CoreIngestService } from '../channel/core-ingest.service';
import { farmPublicUrl } from '../channel/public-origin';
import { WaSessionService } from '../wa-session/wa-session.service';
import { RedisStreamService } from './redis-stream.service';
import { ConsentService } from '../consent/consent.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import {
  dealTemperature,
  type DealLevel,
  type DealStage,
} from '../dashboard/deal-temperature';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

const BRIEF_SELECT = {
  stage: true,
  stageConfidence: true,
  contextSummary: true,
  producerPosition: true,
  dealChange: true,
  intent: true,
  urgency: true,
  painPoint: true,
  nextAction: true,
  nextActionReason: true,
  nextActionOwner: true,
  nextActionKind: true,
  nextActionDueHint: true,
  nextActionDueAt: true,
  suggestedReply: true,
  managerGuidance: true,
  analysisQuality: true,
  blockerSubtype: true,
  products: true,
  evidenceMessageId: true,
  updatedAt: true,
} as const;

type BriefRow = {
  stage: string;
  stageConfidence: number;
  contextSummary: string;
  producerPosition: string | null;
  dealChange: string | null;
  intent: string;
  urgency: string;
  painPoint: string | null;
  nextAction: string;
  nextActionReason: string | null;
  nextActionOwner: string;
  nextActionKind: string;
  nextActionDueHint: string | null;
  nextActionDueAt: Date | null;
  suggestedReply: string | null;
  managerGuidance: string | null;
  analysisQuality: string;
  blockerSubtype: string | null;
  products: unknown;
  evidenceMessageId: string;
  updatedAt: Date;
};

/** Card de Bordo: brief + temperatura calculada na leitura. */
function toBriefView(
  brief: BriefRow,
  last: { sentAt: Date; direction: string } | null | undefined,
  now: Date,
) {
  return {
    stage: brief.stage as DealStage,
    stageConfidence: brief.stageConfidence,
    temperature: dealTemperature(
      {
        stage: brief.stage as DealStage,
        intent: brief.intent as DealLevel,
        urgency: brief.urgency as DealLevel,
        lastMessageAt: last?.sentAt ?? null,
        lastDirection: (last?.direction as 'IN' | 'OUT' | undefined) ?? null,
      },
      now,
    ),
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
    products: Array.isArray(brief.products) ? (brief.products as string[]) : [],
    evidenceMessageId: brief.evidenceMessageId,
    updatedAt: brief.updatedAt,
  };
}

/**
 * Inbox do RTV. Escopo: MEMBER (RTV) enxerga apenas conversas dos números
 * atribuídos a ele; OWNER/ADMIN/MANAGER enxergam o tenant inteiro.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wabaCloud: WabaCloudFactory,
    private readonly storage: StorageService,
    private readonly voice: VoiceClient,
    private readonly email: EmailClient,
    private readonly core: CoreIngestService,
    private readonly waSession: WaSessionService,
    private readonly stream: RedisStreamService,
    private readonly consent: ConsentService,
  ) {}

  private numberScope(user: TenantContext) {
    return ADMIN_ROLES.has(user.role)
      ? {}
      : { channelEndpoint: { assignedUserId: user.userId } };
  }

  async listConversations(user: TenantContext) {
    const now = new Date();
    const conversations = await this.prisma.conversation.findMany({
      where: { tenantId: user.tenantId, ...this.numberScope(user) },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      take: 100,
      include: {
        producer: { select: { id: true, name: true } },
        brief: { select: BRIEF_SELECT },
        wabaNumber: { select: { id: true, displayNumber: true } },
        channelEndpoint: {
          select: {
            id: true,
            displayAddress: true,
            channelAccount: { select: { kind: true } },
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: {
            id: true,
            type: true,
            body: true,
            direction: true,
            sentAt: true,
            transcript: true,
          },
        },
      },
    });
    return conversations.map((c) => ({
      id: c.id,
      producerPhone: c.producerPhone ?? c.peerAddress,
      producer: c.producer,
      wabaNumber: {
        id: c.wabaNumber?.id ?? c.channelEndpoint.id,
        displayNumber:
          c.wabaNumber?.displayNumber ?? c.channelEndpoint.displayAddress,
      },
      channelKind: c.channelEndpoint.channelAccount.kind,
      emailSubject: c.emailSubject,
      lastMessageAt: c.lastMessageAt,
      lastMessage: c.messages[0] ?? null,
      brief: c.brief
        ? (() => {
            const v = toBriefView(c.brief, c.messages[0], now);
            return {
              stage: v.stage,
              temperature: v.temperature,
              nextAction: v.nextAction,
              nextActionKind: v.nextActionKind,
              updatedAt: v.updatedAt,
            };
          })()
        : null,
    }));
  }

  /** Card de Bordo completo. Respeita o mesmo escopo de número do RTV. */
  async getBrief(user: TenantContext, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        tenantId: user.tenantId,
        ...this.numberScope(user),
      },
      select: {
        id: true,
        producerId: true,
        brief: { select: BRIEF_SELECT },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { sentAt: true, direction: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    // Envelope: Nest devolve corpo vazio para `null` e o fetch do web quebra no .json()
    if (conversation.brief) {
      const quality = conversation.brief.analysisQuality;
      // PARTIAL/STALE = fail-open (Gemini 503, deal inválido). Sem kick o Card
      // fica para sempre com o aviso de revisão — o poll do inbox já existe.
      if (quality === 'PARTIAL' || quality === 'STALE') {
        await this.kickLatestInbound(
          user.tenantId,
          conversationId,
          conversation.producerId,
          120,
        );
      }
      return {
        brief: toBriefView(
          conversation.brief,
          conversation.messages[0],
          new Date(),
        ),
        analysis: 'ready' as const,
      };
    }

    const inbound = await this.findLatestAnalyzableInbound(
      user.tenantId,
      conversationId,
    );
    if (!inbound) {
      return { brief: null, analysis: 'waiting_producer' as const };
    }
    if (
      !(await this.consent.canAnalyze(user.tenantId, conversation.producerId))
    ) {
      return { brief: null, analysis: 'blocked' as const };
    }
    // Mensagem do produtor já chegou, mas o DealBrief não — a fila original
    // pode ter sido consumida em fail-open ou o worker estava fora. Reenfileira.
    await this.kickAnalysis(inbound);
    return { brief: null, analysis: 'pending' as const };
  }

  private async findLatestAnalyzableInbound(
    tenantId: string,
    conversationId: string,
  ) {
    return this.prisma.message.findFirst({
      where: {
        tenantId,
        conversationId,
        direction: 'IN',
        OR: [
          { type: 'TEXT', body: { not: null } },
          { transcript: { not: null } },
          {
            type: 'AUDIO',
            mediaStatus: { in: ['PENDING_MEDIA', 'READY'] },
          },
          {
            type: { in: ['IMAGE', 'DOCUMENT', 'OTHER'] },
            body: { not: null },
          },
        ],
      },
      orderBy: { sentAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        conversationId: true,
        sessionId: true,
        type: true,
      },
    });
  }

  private async kickLatestInbound(
    tenantId: string,
    conversationId: string,
    producerId: string | null,
    ttlSec = 30,
  ): Promise<void> {
    if (
      producerId &&
      !(await this.consent.canAnalyze(tenantId, producerId))
    ) {
      return;
    }
    const inbound = await this.findLatestAnalyzableInbound(
      tenantId,
      conversationId,
    );
    if (!inbound) return;
    await this.kickAnalysis(inbound, ttlSec);
  }

  private async kickAnalysis(
    message: {
      id: string;
      tenantId: string;
      conversationId: string;
      sessionId: string | null;
      type: string;
    },
    ttlSec = 30,
  ): Promise<void> {
    const claimed = await this.stream.claimOnce(message.id, ttlSec);
    if (!claimed) return;
    await this.stream.publishMessageReady({
      messageId: message.id,
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      sessionId: message.sessionId ?? '',
      type: message.type,
    });
  }

  async getConversationForUser(user: TenantContext, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        tenantId: user.tenantId,
        ...this.numberScope(user),
      },
      include: {
        wabaNumber: { include: { wabaAccount: true } },
        channelEndpoint: { include: { channelAccount: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  async listMessages(
    user: TenantContext,
    conversationId: string,
    before?: string,
  ) {
    await this.getConversationForUser(user, conversationId);
    const messages = await this.prisma.message.findMany({
      where: {
        tenantId: user.tenantId,
        conversationId,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: 50,
      select: {
        id: true,
        wamid: true,
        direction: true,
        type: true,
        body: true,
        transcript: true,
        coachNote: true,
        coachTone: true,
        mediaStatus: true,
        mediaAssetId: true,
        senderUserId: true,
        sentAt: true,
      },
    });
    return messages.reverse();
  }

  async sendText(
    user: TenantContext,
    conversationId: string,
    text: string,
    subject?: string,
  ) {
    const conversation = await this.getConversationForUser(
      user,
      conversationId,
    );
    const kind = conversation.channelEndpoint.channelAccount.kind;
    if (kind === 'EMAIL') {
      return this.sendEmail(user, conversation, text, subject);
    }
    if (kind === 'WA_SESSION') {
      // Porta trocável (Evolution/Baileys hoje, Evolution/Cloud API depois). Gate de sessão + teto do dia lá dentro.
      const outbound = this.waSession.outboundFor(
        conversation.channelEndpoint.channelAccount,
        'inbox',
      );
      const vendorId = await outbound.sendText(conversation.peerAddress, text);
      return this.persistOutgoing(user, conversation.id, {
        wamid: `evo:${vendorId}`,
        type: 'TEXT' as const,
        body: text,
      });
    }
    if (kind !== 'WABA') {
      throw new ForbiddenException('Envio de texto só no WABA ou e-mail');
    }
    const { client, apiKey, to } = this.wabaDest(conversation);
    const wamid = await client.sendText(apiKey, to, text);
    return this.persistOutgoing(user, conversation.id, {
      wamid,
      type: 'TEXT' as const,
      body: text,
    });
  }

  async sendAudio(
    user: TenantContext,
    conversationId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const conversation = await this.getConversationForUser(
      user,
      conversationId,
    );
    if (conversation.channelEndpoint.channelAccount.kind !== 'WABA') {
      throw new ForbiddenException('Áudio só no canal WABA');
    }
    const { client, apiKey, to } = this.wabaDest(conversation);
    const contentType = file.mimetype.split(';')[0].trim() || 'audio/ogg';
    const mediaId = await client.uploadMedia(
      apiKey,
      file.buffer,
      contentType,
      file.originalname || 'audio',
    );
    const wamid = await client.sendAudio(apiKey, to, mediaId);

    const message = await this.persistOutgoing(user, conversation.id, {
      wamid,
      type: 'AUDIO' as const,
      body: null,
    });

    // Cópia permanente no storage próprio (a mídia na Meta expira em 30 dias)
    if (this.storage.enabled) {
      const storageKey = `${user.tenantId}/${conversation.id}/${message.id}`;
      await this.storage.putObject(storageKey, file.buffer, contentType);
      const asset = await this.prisma.mediaAsset.create({
        data: {
          tenantId: user.tenantId,
          storageKey,
          contentType,
          sizeBytes: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
        },
      });
      return this.prisma.message.update({
        where: { id: message.id },
        data: { mediaStatus: 'READY', mediaAssetId: asset.id },
      });
    }
    return message;
  }

  async startCall(user: TenantContext, conversationId: string) {
    const conversation = await this.getConversationForUser(
      user,
      conversationId,
    );
    const account = conversation.channelEndpoint.channelAccount;
    if (account.kind !== 'VOICE') {
      throw new ForbiddenException('Ligar só no canal de voz');
    }
    const origin = farmPublicUrl();
    if (!origin) {
      throw new BadRequestException('FARM_PUBLIC_URL não configurada');
    }
    const to = e164(conversation.peerAddress);
    const from = e164(conversation.channelEndpoint.address);
    if (!to || !from) {
      throw new BadRequestException('Números da ligação inválidos');
    }
    if (!conversation.channelEndpoint.assignedUserId) {
      throw new BadRequestException(
        'Nenhum RTV neste número — a ligação não tem para quem tocar',
      );
    }
    const creds = parseVoiceCredentials(account.credentialsEncrypted);
    const call = await this.voice.createCall(creds, {
      from,
      to,
      url: `${origin}/voice/webhook/${account.id}`,
    });
    return { ok: true as const, callSid: call.sid };
  }

  private async sendEmail(
    user: TenantContext,
    conversation: {
      id: string;
      peerAddress: string;
      emailSubject: string | null;
      channelEndpoint: {
        address: string;
        channelAccount: { credentialsEncrypted: string | null };
      };
    },
    text: string,
    requestedSubject?: string,
  ) {
    const creds = parseEmailCredentials(
      conversation.channelEndpoint.channelAccount.credentialsEncrypted,
    );
    const last = await this.prisma.message.findFirst({
      where: {
        tenantId: user.tenantId,
        conversationId: conversation.id,
        wamid: { startsWith: 'email:' },
      },
      orderBy: { sentAt: 'desc' },
      select: { wamid: true },
    });
    const rawId = last?.wamid.replace(/^email:/, '').replace(/:att:.*$/, '');
    const angle = rawId ? `<${rawId}>` : undefined;
    const subject = emailOutboundSubject(
      conversation.emailSubject,
      requestedSubject,
      text,
    );
    const sent = await this.email.sendMessage(creds, {
      from: conversation.channelEndpoint.address,
      to: conversation.peerAddress,
      subject,
      text,
      inReplyTo: angle,
      references: angle,
    });
    const wamid = `email:${sent.id.replace(/^<|>$/g, '')}`;
    const message = await this.persistOutgoing(user, conversation.id, {
      wamid,
      type: 'TEXT',
      body: text,
    });
    if (!conversation.emailSubject) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { emailSubject: subject },
      });
    }
    return message;
  }

  private async persistOutgoing(
    user: TenantContext,
    conversationId: string,
    data: { wamid: string; type: 'TEXT' | 'AUDIO'; body: string | null },
  ) {
    const now = new Date();
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: user.tenantId },
      select: { lastMessageAt: true },
    });
    const session = await this.core.resolveSession(
      user.tenantId,
      conversationId,
      conversation?.lastMessageAt ?? null,
      now,
    );
    const message = await this.prisma.message.create({
      data: {
        tenantId: user.tenantId,
        conversationId,
        sessionId: session.id,
        wamid: data.wamid,
        direction: 'OUT',
        type: data.type,
        body: data.body,
        senderUserId: user.userId,
        sentAt: now,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: now },
    });
    return message;
  }

  async getMediaAsset(user: TenantContext, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, tenantId: user.tenantId },
      include: { message: { select: { conversationId: true } } },
    });
    if (!asset) throw new NotFoundException('Media not found');
    if (!ADMIN_ROLES.has(user.role) && asset.message) {
      // RTV: confirma que a conversa da mídia está no escopo dele
      const scoped = await this.prisma.conversation.findFirst({
        where: {
          id: asset.message.conversationId,
          tenantId: user.tenantId,
          channelEndpoint: { assignedUserId: user.userId },
        },
        select: { id: true },
      });
      if (!scoped) throw new ForbiddenException();
    }
    return asset;
  }

  private wabaDest(conversation: {
    wabaNumber: {
      phoneNumberId: string;
      wabaAccount: { apiTokenEncrypted: string; provider: string };
    } | null;
    producerPhone: string | null;
    peerAddress: string;
  }) {
    const number = conversation.wabaNumber;
    const token = number?.wabaAccount.apiTokenEncrypted;
    if (!number || !token) {
      throw new ForbiddenException('Canal sem credencial WABA');
    }
    return {
      client: this.wabaCloud.for(
        number.wabaAccount.provider,
        number.phoneNumberId,
      ),
      apiKey: decryptSecret(token),
      to: (conversation.producerPhone ?? conversation.peerAddress).replace(
        /^\+/,
        '',
      ),
    };
  }
}
