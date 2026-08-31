import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { IngestService } from './ingest.service';
import { verifyWebhookSignature } from './waba-crypto';
import type { CloudApiWebhookPayload } from './webhook.types';
import { OpsService } from '../ops/ops.service';

/**
 * Webhook da Cloud API (via BSP). Regras não-negociáveis:
 * - responder 200 SEMPRE e rápido (o BSP exige < 80ms) — a ingestão roda
 *   depois da resposta; retries são absorvidos pela idempotência do wamid;
 * - nunca baixar mídia aqui (MediaWorker);
 * - assinatura X-Hub-Signature-256 validada quando a conta tem webhookSecret.
 */
@Controller('waba/webhook')
export class WabaWebhookController {
  private readonly logger = new Logger(WabaWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: IngestService,
    private readonly ops: OpsService,
  ) {}

  /** Handshake de verificação (padrão Meta: hub.challenge). */
  @Public()
  @SkipThrottle()
  @Get(':accountId')
  async verify(
    @Param('accountId') accountId: string,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
  ): Promise<string> {
    const account = await this.prisma.wabaAccount.findUnique({
      where: { id: accountId },
    });
    const ok =
      mode === 'subscribe' &&
      account &&
      (!account.webhookSecret || verifyToken === account.webhookSecret);
    return ok ? (challenge ?? '') : '';
  }

  @Public()
  @SkipThrottle()
  @Post(':accountId')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('accountId') accountId: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): { ok: true } {
    // Fire-and-forget: valida e ingere após responder 200.
    void this.process(accountId, req).catch((err: Error) =>
      this.logger.error(`webhook processing failed: ${err.message}`),
    );
    return { ok: true };
  }

  private async process(
    accountId: string,
    req: Request & { rawBody?: Buffer },
  ): Promise<void> {
    const account = await this.prisma.wabaAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.status === 'DISABLED') {
      this.logger.warn(`webhook for unknown/disabled account ${accountId}`);
      return;
    }
    const signature = req.get('x-hub-signature-256');
    if (
      !verifyWebhookSignature(req.rawBody, signature, account.webhookSecret)
    ) {
      this.logger.warn(`invalid webhook signature for account ${accountId}`);
      return;
    }
    this.ops.record({
      service: 'farm-backend',
      stage: 'waba.webhook.received',
      message: `account ${accountId}`,
      tenantId: account.tenantId,
    });
    const payload = req.body as CloudApiWebhookPayload;
    await this.ingest.ingestWebhookPayload(
      accountId,
      account.tenantId,
      payload,
    );
  }
}
