import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WabaModule } from '../waba/waba.module';
import { ConsentModule } from '../consent/consent.module';
import { InternalController } from './internal.controller';
import { FactsIngestService } from './facts-ingest.service';

/** API interna (worker Python → backend) protegida por INTERNAL_API_TOKEN. */
@Module({
  imports: [PrismaModule, WabaModule, ConsentModule],
  controllers: [InternalController],
  providers: [FactsIngestService],
  exports: [FactsIngestService],
})
export class InternalModule {}
