import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVoiceAccountDto {
  @IsString()
  @IsNotEmpty()
  accountSid!: string;

  @IsString()
  @IsNotEmpty()
  authToken!: string;

  /** API Key SK… — softphone (Access Token). */
  @IsOptional()
  @IsString()
  apiKeySid?: string;

  @IsOptional()
  @IsString()
  apiKeySecret?: string;

  /** TwiML App AP… — outgoing do Voice JS SDK. Voice URL = webhook da conta. */
  @IsOptional()
  @IsString()
  twimlAppSid?: string;
}

export class PatchVoiceAccountDto {
  @IsOptional()
  @IsString()
  apiKeySid?: string;

  @IsOptional()
  @IsString()
  apiKeySecret?: string;

  @IsOptional()
  @IsString()
  twimlAppSid?: string;
}

export class CreateVoiceNumberDto {
  /** E.164 do número Farm na Twilio */
  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsOptional()
  @IsString()
  assignedUserId?: string;

  /** E.164 do celular do RTV (ponte PSTN). Grava em User.phone. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  rtvPhone?: string;
}

export class AssignVoiceNumberDto {
  @IsOptional()
  @IsString()
  assignedUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  rtvPhone?: string;
}
