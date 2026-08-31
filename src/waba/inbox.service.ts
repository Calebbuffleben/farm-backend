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
import type { TenantContext } from '../tenancy/tenant-context.types';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

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
  ) {}

  private numberScope(user: TenantContext) {
    return ADMIN_ROLES.has(user.role)
      ? {}
      : { channelEndpoint: { assignedUserId: user.userId } };
  }

  async listConversations(user: TenantContext) {
    const conversations = await this.prisma.conversation.findMany({
      where: { tenantId: user.tenantId, ...this.numberScope(user) },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      take: 100,
      include: {
        producer: { select: { id: true, name: true } },
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
    }));
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
