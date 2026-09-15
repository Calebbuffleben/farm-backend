import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { OpsModule } from '../ops/ops.module';
import { EvolutionClient } from './evolution.client';
import { WaSessionService } from './wa-session.service';
import { OutboundQueue } from './outbound.queue';
import { WaSessionController } from './wa-session.controller';
import { WaSessionWebhookController } from './wa-session-webhook.controller';

/**
 * WhatsApp do RTV via Evolution API auto-hospedada: pareamento, webhook,
 * porta de envio com rampa/teto e fila de relatório. Não importa WabaModule
 * (WabaModule importa este para Inbox e MediaWorker).
 */
@Module({
  imports: [PrismaModule, ChannelModule, OpsModule],
  controllers: [WaSessionController, WaSessionWebhookController],
  providers: [EvolutionClient, WaSessionService, OutboundQueue],
  exports: [EvolutionClient, WaSessionService],
})
export class WaSessionModule {}
