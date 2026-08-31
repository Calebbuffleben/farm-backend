import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import {
  BillingListQueryDto,
  CheckoutListQueryDto,
} from './dto/platform-admin.dto';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformBillingService } from './platform-billing.service';

@Controller('platform-admin/billing')
@Public()
@UseGuards(PlatformAdminGuard)
@SkipThrottle()
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('summary')
  summary() {
    return this.billing.summary();
  }

  @Get('subscriptions')
  listSubscriptions(@Query() query: BillingListQueryDto) {
    return this.billing.listSubscriptions(query);
  }

  @Get('checkouts')
  listCheckouts(@Query() query: CheckoutListQueryDto) {
    return this.billing.listCheckouts(query);
  }

  @Get('tenants/:tenantId')
  getTenant(@Param('tenantId') tenantId: string) {
    return this.billing.getTenantBilling(tenantId);
  }

  @Post('tenants/:tenantId/sync')
  sync(@Param('tenantId') tenantId: string) {
    return this.billing.sync(tenantId);
  }

  @Post('tenants/:tenantId/cancel')
  cancel(@Param('tenantId') tenantId: string) {
    return this.billing.cancel(tenantId);
  }

  @Post('tenants/:tenantId/reactivate')
  reactivate(@Param('tenantId') tenantId: string) {
    return this.billing.reactivate(tenantId);
  }

  @Post('tenants/:tenantId/portal-link')
  portalLink(@Param('tenantId') tenantId: string) {
    return this.billing.portalLink(tenantId);
  }
}
