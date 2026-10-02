import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateDemoLeadDto {
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  company!: string;

  @Transform(trimString)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  phone!: string;

  @IsBoolean()
  @Equals(true, { message: 'consent is required' })
  consent!: boolean;

  /** Honeypot. Bots fill this; humans never see it. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyUrl?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmSource?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmMedium?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmCampaign?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmContent?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmTerm?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  gclid?: string;
}
