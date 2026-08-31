import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsentModule } from '../consent/consent.module';
import { OpsModule } from '../ops/ops.module';
import { RedisStreamService } from '../waba/redis-stream.service';
import { CoreIngestService } from './core-ingest.service';

/**
 * Conversation core: ingestão normalizada + stream farm:messages:ready.
 * Adapters de canal (WABA, voz, e-mail) ficam nos respectivos módulos.
 */
@Module({
  imports: [PrismaModule, ConsentModule, OpsModule],
  providers: [RedisStreamService, CoreIngestService],
  exports: [RedisStreamService, CoreIngestService],
})
export class ChannelModule {}
