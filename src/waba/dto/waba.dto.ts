import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWabaAccountDto {
  /** Token: D360-API-KEY (BSP) ou system user token (META_DIRECT). Cifrado, nunca retornado. */
  @IsString()
  @IsNotEmpty()
  apiToken!: string;

  @IsOptional()
  @IsIn(['BSP_360DIALOG', 'META_DIRECT'])
  provider?: 'BSP_360DIALOG' | 'META_DIRECT';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  webhookSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  wabaExternalId?: string;
}

export class CreateWabaNumberDto {
  /** phone_number_id da Cloud API — chave de roteamento do webhook */
  @IsString()
  @IsNotEmpty()
  phoneNumberId!: string;

  /** E.164 exibível, ex.: +5566999990000 */
  @IsString()
  @IsNotEmpty()
  displayNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  assignedUserId?: string;
}

export class AssignWabaNumberDto {
  /** userId do RTV designado (null desatribui) */
  @IsOptional()
  @IsString()
  assignedUserId?: string | null;
}

export class ImportWhatsappExportDto {
  /** preview: só lista remetentes; import: grava. */
  @IsOptional()
  @IsIn(['preview', 'import'])
  mode?: 'preview' | 'import';

  /** Remetente do export que é o RTV (escolhido no preview). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  rtvName?: string;

  /** E.164 do produtor — o export não traz o número de forma confiável. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  peerPhone?: string;

  @IsOptional()
  @IsString()
  endpointId?: string;
}

export class SendTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;

  /** EMAIL: assunto da thread nova. Ignorado se a conversa já tem emailSubject. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
}
