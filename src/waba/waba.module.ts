import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsentModule } from '../consent/consent.module';
import { OpsModule } from '../ops/ops.module';
import { ChannelModule } from '../channel/channel.module';
import { VoiceModule } from '../voice/voice.module';
import { EmailModule } from '../email/email.module';
import { StorageModule } from './storage.module';
import { BspClient } from './bsp.client';
import { WabaCloudFactory } from './waba-cloud';
import { IngestService } from './ingest.service';
import { MediaWorker } from './media.worker';
import { InboxService } from './inbox.service';
import { WabaWebhookController } from './webhook.controller';
import { WabaSettingsController } from './waba-settings.controller';
import { InboxController } from './inbox.controller';

/**
 * Canal WABA (Fase 2): webhook de ingestão, media worker assíncrono,
 * onboarding de conta/números e API do inbox do RTV.
 */
@Module({
  imports: [
    PrismaModule,
    ConsentModule,
    OpsModule,
    ChannelModule,
    StorageModule,
    VoiceModule,
    EmailModule,
  ],
  controllers: [WabaWebhookController, WabaSettingsController, InboxController],
  providers: [
    BspClient,
    WabaCloudFactory,
    IngestService,
    MediaWorker,
    InboxService,
  ],
  exports: [StorageModule, InboxService],
})
export class WabaModule {}
