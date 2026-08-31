import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBillingService } from './platform-billing.service';

@Module({
  imports: [PrismaModule, TenancyModule, BillingModule],
  controllers: [PlatformAdminController, PlatformBillingController],
  providers: [PlatformAdminGuard, PlatformAdminService, PlatformBillingService],
})
export class PlatformAdminModule {}
