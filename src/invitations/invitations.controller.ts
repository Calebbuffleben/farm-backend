import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MembershipRole } from '@prisma/client';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { InvitationsService } from './invitations.service';
import {
  AcceptInvitationDto,
  AcceptInvitationPublicDto,
  CreateInvitationDto,
} from './dto/invitations.dto';
import { PrismaService } from '../prisma/prisma.service';

@Controller('invites')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @AdminOnly()
  async create(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreateInvitationDto,
    @Req() req: Request,
  ) {
    if (!user || !user.membershipId) throw new UnauthorizedException();
    return this.invitations.create(
      user.tenantId,
      user.userId,
      user.membershipId,
      dto.email,
      dto.role ?? MembershipRole.MEMBER,
      readMeta(req),
    );
  }

  @Get()
  @AdminOnly()
  @SkipThrottle()
  async list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.invitations.listPending(user.tenantId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async revoke(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') invitationId: string,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.invitations.revoke(
      user.tenantId,
      user.userId,
      invitationId,
      readMeta(req),
    );
  }

  /**
   * Accept an invitation as an AUTHENTICATED user. The token's email must
   * match the caller's email. Creates a Membership in the target tenant
   * so the user can subsequently log in with that tenant's slug.
   */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    // Need the caller's email to match against the invite. Fetch directly
    // — the JWT only carries the userId.
    const caller = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { email: true },
    });
    if (!caller) throw new UnauthorizedException();
    return this.invitations.acceptAuthenticated(
      user.userId,
      caller.email,
      dto.token,
      readMeta(req),
    );
  }

  /**
   * Public accept flow — creates a brand new User AND a Membership in
   * one call. Intended for invitees that have never used the platform.
   * Rate-limited to frustrate token-guessing attacks.
   */
  @Public()
  @Post('accept-public')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async acceptPublic(
    @Body() dto: AcceptInvitationPublicDto,
    @Req() req: Request,
  ) {
    return this.invitations.acceptPublic(
      dto.token,
      dto.password,
      dto.name,
      readMeta(req),
    );
  }
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
