import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { BillingService } from './billing.service';
import { StripeBillingService } from './stripe-billing.service';
import { CreateCheckoutSessionDto, UpgradePlanDto } from './dto/billing.dto';
import { PLAN_MAX_USERS } from './plan-limits';
import { freePlanSwitchAllowed } from './entitlement';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly stripeBilling: StripeBillingService,
  ) {}

  @Get('subscription')
  @SkipThrottle()
  async subscription(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const snapshot = await this.billing.getSubscription(user.tenantId);
    return { ...snapshot, planLimits: PLAN_MAX_USERS };
  }

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async upgrade(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: UpgradePlanDto,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!freePlanSwitchAllowed()) {
      throw new ForbiddenException(
        'Plan changes are managed via the billing portal',
      );
    }
    return this.billing.changePlan(user.tenantId, user.userId, dto.plan, {
      ip: readIp(req),
      userAgent: req.get?.('user-agent') ?? undefined,
    });
  }

  @Public()
  @Post('checkout-session')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createCheckoutSession(@Body() dto: CreateCheckoutSessionDto) {
    return this.stripeBilling.createCheckoutSession(dto);
  }

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    return this.stripeBilling.handleWebhook(req.rawBody, signature);
  }

  @Public()
  @Get('checkout-success')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkoutSuccess(@Query('session_id') sessionId: string | undefined) {
    if (!sessionId?.trim()) {
      throw new BadRequestException('session_id is required');
    }
    return this.stripeBilling.checkoutSuccess(sessionId.trim());
  }

  @Post('portal-session')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  portalSession(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.stripeBilling.createPortalSession(user.tenantId);
  }
}

function readIp(req: Request): string | undefined {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined
  );
}
