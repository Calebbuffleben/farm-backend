import {
  Body,
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../waba/waba-crypto';
import { normalizeEmail } from '../channel/peer-address';
import { farmPublicUrl } from '../channel/public-origin';
import {
  AssignEmailEndpointDto,
  CreateEmailAccountDto,
  CreateEmailEndpointDto,
} from './dto/email.dto';

@Controller('email')
export class EmailSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('accounts')
  @SkipThrottle()
  @AdminOnly()
  async listAccounts(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const accounts = await this.prisma.channelAccount.findMany({
      where: { tenantId: user.tenantId, kind: 'EMAIL' },
      include: {
        endpoints: {
          include: {
            assignedUser: {
              select: { id: true, name: true, email: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map(({ credentialsEncrypted: _c, ...rest }) => ({
      ...rest,
      webhookPath: `/email/webhook/${rest.id}`,
      publicOrigin: farmPublicUrl(),
    }));
  }

  @Post('accounts')
  @AdminOnly()
  async createAccount(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreateEmailAccountDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.channelAccount.create({
      data: {
        tenantId: user.tenantId,
        kind: 'EMAIL',
        credentialsEncrypted: encryptSecret(
          JSON.stringify({
            apiKey: dto.apiKey.trim(),
            domain: dto.domain.trim(),
            signingKey: dto.signingKey.trim(),
            region: dto.region === 'eu' ? 'eu' : 'us',
          }),
        ),
        status: 'ACTIVE',
      },
    });
    return {
      id: account.id,
      status: account.status,
      webhookPath: `/email/webhook/${account.id}`,
    };
  }

  @Post('accounts/:id/addresses')
  @AdminOnly()
  async addAddress(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') accountId: string,
    @Body() dto: CreateEmailEndpointDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId, kind: 'EMAIL' },
    });
    if (!account) throw new NotFoundException('Email account not found');
    const address = normalizeEmail(dto.address);
    if (!address) throw new BadRequestException('E-mail inválido');

    return this.prisma.channelEndpoint.create({
      data: {
        tenantId: user.tenantId,
        channelAccountId: account.id,
        address,
        displayAddress: address,
        assignedUserId: dto.assignedUserId ?? null,
      },
    });
  }

  @Patch('addresses/:id')
  @AdminOnly()
  async assignAddress(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') endpointId: string,
    @Body() dto: AssignEmailEndpointDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        id: endpointId,
        tenantId: user.tenantId,
        channelAccount: { kind: 'EMAIL' },
      },
    });
    if (!endpoint) throw new NotFoundException('Email address not found');
    return this.prisma.channelEndpoint.update({
      where: { id: endpoint.id },
      data: { assignedUserId: dto.assignedUserId ?? null },
    });
  }
}
