import {
  Body,
  Controller,
  Get,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Prisma } from '@prisma/client';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Política comercial do tenant — alimenta o prompt do Next Best Action
 * ("ofereça até X% da alçada"). Só dois campos de propósito; upgrade quando
 * algum gestor pedir regra por produto/região.
 */
export class SalesPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  discountAuthorityPct?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  notes?: string | null;
}

@Controller('tenancy')
export class SalesPolicyController {
  constructor(private readonly prisma: PrismaService) {}

  /** Qualquer membro lê (o RTV vê a alçada que a IA cita). */
  @Get('sales-policy')
  @SkipThrottle()
  async get(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { salesPolicy: true },
    });
    return { salesPolicy: tenant?.salesPolicy ?? null };
  }

  @Patch('sales-policy')
  @AdminOnly()
  async patch(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: SalesPolicyDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const policy: Record<string, unknown> = {};
    if (dto.discountAuthorityPct !== undefined && dto.discountAuthorityPct !== null) {
      policy.discountAuthorityPct = dto.discountAuthorityPct;
    }
    if (dto.notes?.trim()) policy.notes = dto.notes.trim();
    const tenant = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: {
        salesPolicy: Object.keys(policy).length
          ? (policy as Prisma.InputJsonObject)
          : ({} as Prisma.InputJsonObject),
      },
      select: { salesPolicy: true },
    });
    return { salesPolicy: tenant.salesPolicy };
  }
}
