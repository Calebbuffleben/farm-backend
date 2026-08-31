import { MembershipRole } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}

export class AcceptInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}

/**
 * Public accept flow for users that do NOT exist yet. Creates a User AND
 * the Membership in one shot. The email must match the one stamped on
 * the invitation (compared after normalization).
 */
export class AcceptInvitationPublicDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
