import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateEmailAccountDto {
  @IsString()
  @IsNotEmpty()
  apiKey!: string;

  @IsString()
  @IsNotEmpty()
  domain!: string;

  /** HMAC do inbound — não é a API key. */
  @IsString()
  @IsNotEmpty()
  signingKey!: string;

  @IsOptional()
  @IsIn(['us', 'eu'])
  region?: 'us' | 'eu';
}

export class CreateEmailEndpointDto {
  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsOptional()
  @IsString()
  assignedUserId?: string;
}

export class AssignEmailEndpointDto {
  @IsOptional()
  @IsString()
  assignedUserId?: string | null;
}
