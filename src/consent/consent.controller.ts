import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import type { ConsentPurpose } from '@prisma/client';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { ConsentService } from './consent.service';

class ConsentPurposeDto {
  @IsIn(['CONVERSATION_ANALYSIS', 'MEDIA_RETENTION'])
  purpose!: ConsentPurpose;
}

@Controller('consent')
@AdminOnly()
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get()
  list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.consent.list(user.tenantId);
  }

  @Post(':producerId/grant')
  grant(
    @CurrentUser() user: TenantContext | undefined,
    @Param('producerId') producerId: string,
    @Body() dto: ConsentPurposeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.consent.grant(user.tenantId, producerId, dto.purpose);
  }

  @Post(':producerId/revoke')
  revoke(
    @CurrentUser() user: TenantContext | undefined,
    @Param('producerId') producerId: string,
    @Body() dto: ConsentPurposeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.consent.revoke(user.tenantId, producerId, dto.purpose);
  }
}
