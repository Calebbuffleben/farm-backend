import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { e164 } from '../voice/twilio-media';
import { CoreIngestService } from './core-ingest.service';
import { ensureWaSessionEndpoint } from './wa-session-endpoint';
import {
  exportExternalId,
  listSenders,
  parseWhatsappExportTxt,
  withDirection,
} from './whatsapp-export.parse';

export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const EXPORT_MAX_LINES = 2000;
const ADMIN_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

/**
 * Plano B do canal WhatsApp: o RTV exporta a conversa (.txt, sem mídia) e
 * sobe aqui. Cada linha vira NormalizedInbound no endpoint WA_SESSION do RTV.
 */
@Injectable()
export class WhatsappExportImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
  ) {}

  preview(content: string) {
    const lines = this.parse(content);
    return {
      lines: lines.length,
      senders: listSenders(lines),
      firstAt: lines[0]?.sentAt ?? null,
      lastAt: lines[lines.length - 1]?.sentAt ?? null,
    };
  }

  async import(
    user: TenantContext,
    content: string,
    input: { rtvName: string; peerPhone: string; endpointId?: string },
  ) {
    const peer = e164(input.peerPhone);
    if (!peer) throw new BadRequestException('Telefone do produtor inválido (use +55...)');
    if (!input.rtvName.trim()) throw new BadRequestException('Informe quem é você no export');

    const endpoint = await this.resolveEndpoint(user, input.endpointId);
    const lines = withDirection(this.parse(content), input.rtvName);
    if (!lines.length) {
      throw new BadRequestException('Nenhuma mensagem reconhecida — é um export .txt do WhatsApp?');
    }
    if (!lines.some((l) => l.direction === 'OUT')) {
      throw new BadRequestException(
        `Nenhuma linha de "${input.rtvName}" no arquivo — escolha o remetente certo`,
      );
    }

    const ids = lines.map((l) => exportExternalId(endpoint.id, peer, l));
    const existing = new Set(
      (
        await this.prisma.message.findMany({
          where: { tenantId: user.tenantId, wamid: { in: ids } },
          select: { wamid: true },
        })
      ).map((m) => m.wamid),
    );

    let imported = 0;
    for (let i = 0; i < lines.length; i++) {
      if (existing.has(ids[i])) continue;
      const line = lines[i];
      await this.core.ingest({
        tenantId: user.tenantId,
        endpointId: endpoint.id,
        peerAddress: peer,
        externalId: ids[i],
        direction: line.direction,
        type: line.media ? 'OTHER' : 'TEXT',
        body: line.media ? 'Mídia não incluída no export' : line.text,
        sentAt: line.sentAt,
      });
      imported++;
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: {
        channelEndpointId_peerAddress: { channelEndpointId: endpoint.id, peerAddress: peer },
      },
      select: { id: true },
    });
    return {
      imported,
      skipped: lines.length - imported,
      conversationId: conversation?.id ?? null,
    };
  }

  private parse(content: string) {
    const lines = parseWhatsappExportTxt(content);
    if (lines.length > EXPORT_MAX_LINES) {
      throw new BadRequestException(
        `Arquivo com ${lines.length} mensagens; o limite por envio é ${EXPORT_MAX_LINES}. Exporte um período menor.`,
      );
    }
    return lines;
  }

  /** endpointId explícito (admin) ou o WA_SESSION do próprio usuário (criado se preciso). */
  private async resolveEndpoint(user: TenantContext, endpointId?: string) {
    if (!endpointId) {
      return ensureWaSessionEndpoint(this.prisma, user.tenantId, user.userId);
    }
    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        id: endpointId,
        tenantId: user.tenantId,
        channelAccount: { kind: { in: ['WA_SESSION', 'WABA'] } },
      },
    });
    if (!endpoint) throw new NotFoundException('Canal não encontrado');
    if (!ADMIN_ROLES.has(user.role) && endpoint.assignedUserId !== user.userId) {
      throw new ForbiddenException('Só é possível importar para o seu próprio WhatsApp');
    }
    return endpoint;
  }
}
