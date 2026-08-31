import {
  InviteStatus,
  MembershipRole,
  Plan,
  SubscriptionStatus,
  TenantStatus,
} from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PlatformListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class TenantListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}

export class CreateTenantDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'slug must be lowercase alphanumeric with optional hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class UpdateTenantBillingDto {
  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  subscriptionStatus?: SubscriptionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxUsers?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  force?: boolean;
}

export class UserListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}

export class InviteListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsEnum(InviteStatus)
  status?: InviteStatus;
}

export class CreatePlatformInvitationDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}

export class BillingListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsString()
  @Matches(/^(stripe|manual)$/)
  source?: 'stripe' | 'manual';
}

export class CheckoutListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^(PENDING|COMPLETED|EXPIRED|ABANDONED)$/)
  status?: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'ABANDONED';
}
