import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  tenantSlug?: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  tenantSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tenantName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  @MinLength(20)
  refreshToken?: string;
}

export class ServiceTokenDto {
  /** Deprecated. SERVICE tokens are global; tenants are selected per gRPC call. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  tenantSlug?: string;

  /** Optional label for audit log metadata (e.g. "python-service-prod"). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string;

  /** Optional requested TTL in seconds. Clamped server-side to
   * `[60, DEFAULT_SERVICE_TTL_SECONDS * 6]`. */
  @IsOptional()
  ttlSeconds?: number;
}
