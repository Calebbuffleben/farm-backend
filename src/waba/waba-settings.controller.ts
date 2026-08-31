import {
  Body,
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
import { encryptSecret } from './waba-crypto';
import { farmPublicUrl } from '../channel/public-origin';
import {
  ensureWabaChannelAccount,
  ensureWabaChannelEndpoint,
} from '../channel/waba-channel';
import {
  AssignWabaNumberDto,
  CreateWabaAccountDto,
  CreateWabaNumberDto,
} from './dto/waba.dto';

/** Onboarding do canal WABA — conta (token do BSP) e números. Admin do tenant. */
@Controller('waba')
export class WabaSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('accounts')
  @SkipThrottle()
  @AdminOnly()
  async listAccounts(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const accounts = await this.prisma.wabaAccount.findMany({
      where: { tenantId: user.tenantId },
      include: {
        numbers: {
          include: {
            assignedUser: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    // token cifrado nunca sai da API
    return accounts.map(({ apiTokenEncrypted: _token, ...rest }) => ({
      ...rest,
      webhookPath: `/waba/webhook/${rest.id}`,
      publicOrigin: farmPublicUrl(),
    }));
  }

  @Post('accounts')
  @AdminOnly()
  async createAccount(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreateWabaAccountDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.wabaAccount.create({
        data: {
          tenantId: user.tenantId,
          provider: dto.provider ?? 'BSP_360DIALOG',
          apiTokenEncrypted: encryptSecret(dto.apiToken),
          webhookSecret: dto.webhookSecret ?? null,
          wabaExternalId: dto.wabaExternalId ?? null,
          status: 'ACTIVE',
        },
      });
      await ensureWabaChannelAccount(tx, created);
      return created;
    });
    return {
      id: account.id,
      provider: account.provider,
      status: account.status,
      webhookPath: `/waba/webhook/${account.id}`,
    };
  }

  @Post('accounts/:id/numbers')
  @AdminOnly()
  async addNumber(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') accountId: string,
    @Body() dto: CreateWabaNumberDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.wabaAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId },
    });
    if (!account) throw new NotFoundException('WABA account not found');
    return this.prisma.$transaction(async (tx) => {
      const number = await tx.wabaNumber.create({
        data: {
          wabaAccountId: account.id,
          phoneNumberId: dto.phoneNumberId,
          displayNumber: dto.displayNumber,
          displayName: dto.displayName ?? null,
          assignedUserId: dto.assignedUserId ?? null,
        },
      });
      await ensureWabaChannelEndpoint(tx, account, number);
      return number;
    });
  }

  @Patch('numbers/:id')
  @AdminOnly()
  async assignNumber(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') numberId: string,
    @Body() dto: AssignWabaNumberDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const number = await this.prisma.wabaNumber.findFirst({
      where: { id: numberId, wabaAccount: { tenantId: user.tenantId } },
    });
    if (!number) throw new NotFoundException('WABA number not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.wabaNumber.update({
        where: { id: number.id },
        data: { assignedUserId: dto.assignedUserId ?? null },
      });
      await tx.channelEndpoint.updateMany({
        where: { wabaNumberId: number.id },
        data: { assignedUserId: dto.assignedUserId ?? null },
      });
      return updated;
    });
  }
}
