import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { StripeBillingService } from './stripe-billing.service';

@Module({
  imports: [PrismaModule, TenancyModule],
  providers: [BillingService, StripeBillingService],
  controllers: [BillingController],
  exports: [BillingService, StripeBillingService],
})
export class BillingModule {}
