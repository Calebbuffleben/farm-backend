import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { SeatCapacityService } from './seat-capacity.service';
import { StripeBillingService } from './stripe-billing.service';

@Module({
  imports: [PrismaModule, TenancyModule],
  providers: [BillingService, StripeBillingService, SeatCapacityService],
  controllers: [BillingController],
  exports: [BillingService, StripeBillingService, SeatCapacityService],
})
export class BillingModule {}
