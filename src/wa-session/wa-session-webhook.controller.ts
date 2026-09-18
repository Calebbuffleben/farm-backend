import { Body, Controller, HttpCode, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { WaSessionService } from './wa-session.service';
import type { EvolutionWebhook } from './evolution-ingest';

/**
 * Webhook da Evolution API. Não há assinatura HMAC; o segredo vai no path e é
 * comparado com ChannelAccount.webhookSecret (e `payload.apikey` com o token
 * da instância). 200 imediato; ingestão async.
 * Não confundir com /waba/webhook (shape Graph + HMAC).
 */
@Controller('wa-session')
export class WaSessionWebhookController {
  private readonly logger = new Logger(WaSessionWebhookController.name);

  constructor(private readonly sessions: WaSessionService) {}

  @Public()
  @SkipThrottle()
  @Post('webhook/:accountId/:secret')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('accountId') accountId: string,
    @Param('secret') secret: string,
    @Body() payload: EvolutionWebhook,
  ): { ok: true } {
    void this.sessions
      .handleWebhook(accountId, secret, payload ?? {})
      .catch((err: Error) => this.logger.error(`wa-session webhook failed: ${err.message}`));
    return { ok: true };
  }
}
