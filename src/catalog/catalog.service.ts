import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseCsv } from './csv.util';
import { normalizeEmail } from '../channel/peer-address';
import { RedisStreamService } from '../waba/redis-stream.service';

/**
 * Import da carteira (CSV) → Producer/ProducerPhone/Farm/CropSeason.
 * Colunas aceitas (case/acentos ignorados):
 *   produtor* | telefone | email | fazenda* | regiao | area_ha | cultura | safra
 *   | produtor_erp_id | fazenda_erp_id
 * Uma linha = um vínculo produtor+fazenda(+safra). Linhas repetidas fazem
 * upsert — o import pode ser rodado de novo sem duplicar.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: RedisStreamService,
  ) {}

  async importCarteira(tenantId: string, csvContent: string) {
    const rows = parseCsv(csvContent);
    if (!rows.length) {
      throw new BadRequestException('CSV vazio ou sem linhas de dados');
    }

    const summary = {
      rows: rows.length,
      producers: 0,
      phones: 0,
      emails: 0,
      farms: 0,
      cropSeasons: 0,
      errors: [] as string[],
    };
    const producerCache = new Map<string, string>(); // nome → id
    const farmCache = new Map<string, string>(); // produtorId/nome → id

    for (const [index, row] of rows.entries()) {
      const line = index + 2; // 1-based + cabeçalho
      const producerName = row.produtor || row.produtor_nome || row.nome;
      const farmName = row.fazenda || row.fazenda_nome;
      if (!producerName || !farmName) {
        summary.errors.push(`linha ${line}: produtor e fazenda são obrigatórios`);
        continue;
      }

      try {
        const producerId = await this.upsertProducer(
          tenantId,
          producerName,
          row.produtor_erp_id || null,
          producerCache,
          summary,
        );

        const phone = normalizePhone(row.telefone);
        if (phone) {
          await this.upsertPhone(tenantId, producerId, phone, summary);
        }

        const email = normalizeEmail(row.email || row.e_mail);
        if (email) {
          await this.upsertEmail(tenantId, producerId, email, summary);
        }

        const farmId = await this.upsertFarm(
          tenantId,
          producerId,
          farmName,
          row,
          farmCache,
          summary,
        );

        const crop = (row.cultura || row.crop || '').toLowerCase();
        const season = row.safra || row.season || '';
        if (crop && season) {
          await this.prisma.cropSeason.upsert({
            where: {
              farmId_crop_seasonLabel: { farmId, crop, seasonLabel: season },
            },
            create: {
              tenantId,
              farmId,
              crop,
              seasonLabel: season,
              areaHa: parseDecimal(row.area_ha || row.area),
            },
            update: {
              tenantId,
              areaHa: parseDecimal(row.area_ha || row.area),
            },
          });
          summary.cropSeasons++;
        }
      } catch (err) {
        summary.errors.push(`linha ${line}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `carteira import tenant=${tenantId} rows=${summary.rows} producers=${summary.producers} farms=${summary.farms} errors=${summary.errors.length}`,
    );
    return summary;
  }

  private async upsertProducer(
    tenantId: string,
    name: string,
    erpId: string | null,
    cache: Map<string, string>,
    summary: { producers: number },
  ): Promise<string> {
    const cacheKey = erpId || name.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const existing = await this.prisma.producer.findFirst({
      where: {
        tenantId,
        ...(erpId
          ? { externalErpId: erpId }
          : { name: { equals: name, mode: 'insensitive' } }),
      },
    });
    const producer =
      existing ??
      (await this.prisma.producer.create({
        data: { tenantId, name, externalErpId: erpId },
      }));
    if (!existing) summary.producers++;
    cache.set(cacheKey, producer.id);
    return producer.id;
  }

  private async upsertPhone(
    tenantId: string,
    producerId: string,
    phone: string,
    summary: { phones: number },
  ): Promise<void> {
    const existing = await this.prisma.producerPhone.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    });
    if (existing) {
      if (existing.producerId !== producerId) {
        throw new Error(
          `telefone ${phone} já pertence a outro produtor — resolva manualmente`,
        );
      }
      return;
    }
    await this.prisma.producerPhone.create({
      data: { tenantId, producerId, phone },
    });
    summary.phones++;

    // Reconcilia conversas que chegaram antes da carteira
    await this.prisma.conversation.updateMany({
      where: {
        tenantId,
        producerId: null,
        OR: [{ producerPhone: phone }, { peerAddress: phone }],
      },
      data: { producerId },
    });
  }

  private async upsertEmail(
    tenantId: string,
    producerId: string,
    email: string,
    summary: { emails: number },
  ): Promise<void> {
    const existing = await this.prisma.producerEmail.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });
    if (existing) {
      if (existing.producerId !== producerId) {
        throw new Error(
          `e-mail ${email} já pertence a outro produtor — resolva manualmente`,
        );
      }
      return;
    }
    await this.prisma.producerEmail.create({
      data: { tenantId, producerId, email },
    });
    summary.emails++;

    await this.prisma.conversation.updateMany({
      where: { tenantId, peerAddress: email, producerId: null },
      data: { producerId },
    });
  }

  private async upsertFarm(
    tenantId: string,
    producerId: string,
    name: string,
    row: Record<string, string>,
    cache: Map<string, string>,
    summary: { farms: number },
  ): Promise<string> {
    const cacheKey = `${producerId}/${name.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const existing = await this.prisma.farm.findFirst({
      where: {
        tenantId,
        producerId,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    const farm =
      existing ??
      (await this.prisma.farm.create({
        data: {
          tenantId,
          producerId,
          name,
          region: row.regiao || row.region || null,
          areaHa: parseDecimal(row.area_ha || row.area),
          externalErpId: row.fazenda_erp_id || null,
        },
      }));
    if (!existing) summary.farms++;
    cache.set(cacheKey, farm.id);
    return farm.id;
  }

  async listProducers(tenantId: string) {
    return this.prisma.producer.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: {
        phones: { select: { phone: true, label: true } },
        emails: { select: { email: true, label: true } },
        farms: {
          select: {
            id: true,
            name: true,
            region: true,
            areaHa: true,
            cropSeasons: {
              select: { crop: true, seasonLabel: true, areaHa: true },
            },
          },
        },
      },
    });
  }

  async listUnknowns(tenantId: string) {
    const items = await this.prisma.unknownQueueItem.findMany({
      where: { tenantId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        message: {
          select: {
            id: true,
            body: true,
            transcript: true,
            sentAt: true,
            conversation: {
              select: {
                id: true,
                producerPhone: true,
                peerAddress: true,
                producer: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    return items.map((item) => ({
      ...item,
      message: {
        ...item.message,
        conversation: {
          ...item.message.conversation,
          producerPhone:
            item.message.conversation.producerPhone ??
            item.message.conversation.peerAddress,
        },
      },
    }));
  }

  /** Resolução em 1 toque: humano aponta a fazenda → EntityLink HUMAN. */
  async resolveUnknown(
    tenantId: string,
    userId: string,
    unknownId: string,
    farmId: string | null,
  ) {
    const item = await this.prisma.unknownQueueItem.findFirst({
      where: { id: unknownId, tenantId, status: 'PENDING' },
    });
    if (!item) {
      throw new BadRequestException('Item não encontrado ou já resolvido');
    }
    if (farmId) {
      const farm = await this.prisma.farm.findFirst({
        where: { id: farmId, tenantId },
        select: { id: true },
      });
      if (!farm) throw new BadRequestException('Fazenda inválida');
      await this.prisma.entityLink.create({
        data: {
          tenantId,
          messageId: item.messageId,
          farmId,
          spanText: item.spanText,
          confidence: 1,
          source: 'HUMAN',
          createdById: userId,
        },
      });
    }
    const updated = await this.prisma.unknownQueueItem.update({
      where: { id: item.id },
      data: {
        status: farmId ? 'RESOLVED' : 'DISMISSED',
        resolvedFarmId: farmId,
        resolvedById: userId,
        resolvedAt: new Date(),
      },
    });
    if (farmId) {
      const message = await this.prisma.message.findFirst({
        where: { id: item.messageId, tenantId },
        select: {
          id: true,
          tenantId: true,
          conversationId: true,
          sessionId: true,
          type: true,
        },
      });
      if (message) {
        await this.stream.publishMessageReady({
          messageId: message.id,
          tenantId: message.tenantId,
          conversationId: message.conversationId,
          sessionId: message.sessionId ?? '',
          type: message.type,
        });
      }
    }
    return updated;
  }
}

function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `+${digits}`;
}

function parseDecimal(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
