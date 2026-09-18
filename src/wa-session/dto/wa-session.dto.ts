import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectWaSessionDto {
  /** E.164 do RTV → código de pareamento. Sem phone → QR. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  /** Checkbox: conexão via API Web, sujeita às políticas da Meta. */
  @IsBoolean()
  accepted!: boolean;
}

export class PairingCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;
}
