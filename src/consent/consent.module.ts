import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { OpsModule } from '../ops/ops.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

@Module({
  imports: [PrismaModule, OpsModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
