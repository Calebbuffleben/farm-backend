import { Plan } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpgradePlanDto {
  @IsEnum(Plan)
  plan!: Plan;
}

export class CreateCheckoutSessionDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsString()
  @MaxLength(200)
  tenantName!: string;

  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'slug must be lowercase alphanumeric with optional hyphens',
  })
  tenantSlug!: string;

  @IsEnum(Plan)
  plan!: Plan;
}
