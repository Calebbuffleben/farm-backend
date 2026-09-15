import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerAccess } from '../auth/decorators/roles.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { WaSessionService } from './wa-session.service';
import { OutboundQueue } from './outbound.queue';
import { ConnectWaSessionDto, PairingCodeDto } from './dto/wa-session.dto';

/** WhatsApp do RTV (sessão). MEMBER opera o próprio; gestor vê todos. */
@Controller('wa-session')
export class WaSessionController {
  constructor(
    private readonly sessions: WaSessionService,
    private readonly queue: OutboundQueue,
  ) {}

  @Get('me')
  @SkipThrottle()
  me(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.me(user);
  }

  @Get('instances')
  @SkipThrottle()
  @ManagerAccess()
  list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.listForTenant(user);
  }

  @Post('instances')
  connect(@CurrentUser() user: TenantContext | undefined, @Body() dto: ConnectWaSessionDto) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.connect(user, { phone: dto.phone, accepted: dto.accepted });
  }

  @Get('instances/:id')
  @SkipThrottle()
  poll(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
    @Query('qr') qr?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.poll(user, id, qr === '1');
  }

  @Post('instances/:id/pairing-code')
  pairingCode(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
    @Body() dto: PairingCodeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.pairingCode(user, id, dto.phone);
  }

  @Post('instances/:id/logout')
  logout(@CurrentUser() user: TenantContext | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.sessions.logout(user, id);
  }

  @Get('conversations/:id/report-eligibility')
  @SkipThrottle()
  eligibility(@CurrentUser() user: TenantContext | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.queue.eligibility(user, id);
  }

  @Post('conversations/:id/report')
  @ManagerAccess()
  sendReport(@CurrentUser() user: TenantContext | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.queue.enqueueReport(user, id);
  }
}
