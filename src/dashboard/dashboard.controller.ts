import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { FactStatus } from '@prisma/client';

import { ManagerAccess } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { DashboardService } from './dashboard.service';

class HomeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @IsOptional()
  @IsString()
  rtvUserId?: string;

  @IsOptional()
  @IsString()
  farmId?: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  productKey?: string;
}

class PatchFactDto {
  @IsIn(['OPEN', 'RESOLVED', 'DISMISSED'])
  status!: FactStatus;
}

class DiscountReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  text!: string;
}

@Controller('dashboard')
@ManagerAccess()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('home')
  @SkipThrottle()
  home(
    @CurrentUser() user: TenantContext | undefined,
    @Query() query: HomeQueryDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.dashboard.home(user.tenantId, query.days ?? 7, {
      rtvUserId: query.rtvUserId,
      farmId: query.farmId,
      crop: query.crop,
      region: query.region,
      productKey: query.productKey,
    });
  }

  @Get('facts/:id')
  @SkipThrottle()
  getFact(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') factId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.dashboard.getFact(user.tenantId, user.userId, factId);
  }

  @Patch('facts/:id')
  patchFact(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') factId: string,
    @Body() dto: PatchFactDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.dashboard.patchFact(user.tenantId, factId, dto.status);
  }

  @Post('facts/:id/discount-reply')
  @HttpCode(HttpStatus.OK)
  discountReply(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') factId: string,
    @Body() dto: DiscountReplyDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.dashboard.discountReply(user, factId, dto.text);
  }
}
