import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { MembersService } from './members.service';
import { UpdateMemberRoleDto } from './dto/members.dto';

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** List members. Any authenticated member of the tenant can read. */
  @Get()
  @SkipThrottle()
  async list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.members.list(user.tenantId);
  }

  @Patch(':id/role')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async updateRole(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') membershipId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.members.changeRole(
      user.tenantId,
      user.userId,
      actorRoleFrom(user),
      membershipId,
      dto.role,
      readMeta(req),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async remove(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') membershipId: string,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.members.remove(
      user.tenantId,
      user.userId,
      actorRoleFrom(user),
      membershipId,
      readMeta(req),
    );
  }
}

function actorRoleFrom(user: TenantContext): 'OWNER' | 'ADMIN' {
  // AdminOnly guard already rejected anything outside [OWNER, ADMIN].
  return user.role === 'OWNER' ? 'OWNER' : 'ADMIN';
}

function readMeta(req: Request) {
  return {
    ip:
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      undefined,
    userAgent: req.get?.('user-agent') ?? undefined,
  };
}
