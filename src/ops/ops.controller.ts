import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { ManagerAccess } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { OpsService } from './ops.service';

@Controller()
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  /**
   * Prometheus scrape. Se METRICS_TOKEN estiver setado, exige o header
   * x-metrics-token (ou Bearer). Sem token no env = aberto (dev local).
   */
  @Public()
  @SkipThrottle()
  @Get('metrics')
  async metrics(
    @Res() res: Response,
    @Headers('x-metrics-token') headerToken?: string,
    @Headers('authorization') authorization?: string,
    @Query('token') queryToken?: string,
  ) {
    const expected = process.env.METRICS_TOKEN?.trim();
    if (expected) {
      const bearer = authorization?.startsWith('Bearer ')
        ? authorization.slice(7).trim()
        : undefined;
      const got = headerToken?.trim() || bearer || queryToken?.trim();
      if (got !== expected) throw new ForbiddenException();
    }
    const body = await this.ops.prometheusText();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(body);
  }

  @Get('ops/status')
  @SkipThrottle()
  @ManagerAccess()
  status(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.ops.snapshot();
  }
}
