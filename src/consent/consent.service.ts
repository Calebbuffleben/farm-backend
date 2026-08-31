import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConsentPurpose } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { analysisAllowed } from '../ops/ops.policy';
import { OpsService } from '../ops/ops.service';

const PURPOSES: ConsentPurpose[] = ['CONVERSATION_ANALYSIS', 'MEDIA_RETENTION'];

/**
 * LGPD: o produtor é o titular. Ano 1 — o primeiro inbound no canal
 * corporativo grava o grant (`waba_first_contact`). Upgrade: enviar template
 * WABA de opt-in e só gravar o grant na resposta.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsService,
  ) {}

  async canAnalyze(
    tenantId: string,
    producerId: string | null | undefined,
  ): Promise<boolean> {
    if (!producerId) return true;
    const record = await this.prisma.consentRecord.findUnique({
      where: {
        producerId_purpose: {
          producerId,
          purpose: 'CONVERSATION_ANALYSIS',
        },
      },
      select: { revokedAt: true },
    });
    return analysisAllowed(record);
  }

  /** Idempotente. Não reabre consentimento revogado. */
  async ensureFirstContact(
    tenantId: string,
    producerId: string | null | undefined,
    source = 'waba_first_contact',
  ): Promise<void> {
    if (!producerId) return;
    for (const purpose of PURPOSES) {
      const existing = await this.prisma.consentRecord.findUnique({
        where: { producerId_purpose: { producerId, purpose } },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.consentRecord.create({
        data: {
          tenantId,
          producerId,
          purpose,
          source,
        },
      });
      this.ops.record({
        service: 'farm-backend',
        stage: 'consent.granted',
        message: `first contact grant ${purpose}`,
        tenantId,
        metadata: { producerId, purpose, source },
      });
    }
  }

  async list(tenantId: string) {
    return this.prisma.consentRecord.findMany({
      where: { tenantId },
      orderBy: { grantedAt: 'desc' },
      take: 200,
      include: { producer: { select: { id: true, name: true } } },
    });
  }

  async grant(
    tenantId: string,
    producerId: string,
    purpose: ConsentPurpose,
    source = 'human_admin',
  ) {
    await this.assertProducer(tenantId, producerId);
    const row = await this.prisma.consentRecord.upsert({
      where: { producerId_purpose: { producerId, purpose } },
      create: { tenantId, producerId, purpose, source },
      update: { revokedAt: null, source, grantedAt: new Date() },
    });
    this.ops.record({
      service: 'farm-backend',
      stage: 'consent.granted',
      message: `grant ${purpose}`,
      tenantId,
      metadata: { producerId, purpose, source },
    });
    return row;
  }

  async revoke(tenantId: string, producerId: string, purpose: ConsentPurpose) {
    await this.assertProducer(tenantId, producerId);
    const existing = await this.prisma.consentRecord.findUnique({
      where: { producerId_purpose: { producerId, purpose } },
    });
    if (!existing) {
      throw new NotFoundException('Consentimento não encontrado');
    }
    const row = await this.prisma.consentRecord.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    if (purpose === 'MEDIA_RETENTION') {
      await this.expireProducerMedia(tenantId, producerId);
    }
    this.ops.record({
      service: 'farm-backend',
      stage: 'consent.revoked',
      message: `revoke ${purpose}`,
      tenantId,
      metadata: { producerId, purpose },
    });
    return row;
  }

  private async expireProducerMedia(tenantId: string, producerId: string) {
    const messages = await this.prisma.message.findMany({
      where: { tenantId, conversation: { producerId } },
      select: { mediaAssetId: true },
    });
    const ids = messages
      .map((m) => m.mediaAssetId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    await this.prisma.mediaAsset.updateMany({
      where: { id: { in: ids } },
      data: { expiresAt: new Date() },
    });
  }

  private async assertProducer(tenantId: string, producerId: string) {
    const producer = await this.prisma.producer.findFirst({
      where: { id: producerId, tenantId },
      select: { id: true },
    });
    if (!producer) throw new NotFoundException('Produtor não encontrado');
  }
}
