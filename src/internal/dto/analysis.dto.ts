import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class AnalysisLinkDto {
  @IsString()
  @IsNotEmpty()
  farmId!: string;

  @IsOptional()
  @IsString()
  cropSeasonId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  spanText?: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;
}

export class AnalysisFactDto {
  @IsIn(['OBJECAO', 'RISCO', 'OPORTUNIDADE', 'FOLLOWUP', 'CONCORRENTE'])
  kind!: 'OBJECAO' | 'RISCO' | 'OPORTUNIDADE' | 'FOLLOWUP' | 'CONCORRENTE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  subtype!: string;

  @IsIn(['INFO', 'WARNING', 'CRITICAL'])
  severity!: 'INFO' | 'WARNING' | 'CRITICAL';

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @IsOptional()
  @IsString()
  farmId?: string;

  @IsOptional()
  @IsString()
  cropSeasonId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  productKey?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  headline!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  moneyHint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dueHintText?: string;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  evidenceSpan?: string;
}

export class AnalysisUnknownCandidateDto {
  @IsString()
  @IsNotEmpty()
  farmId!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;
}

export class AnalysisUnknownDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  spanText?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalysisUnknownCandidateDto)
  candidates!: AnalysisUnknownCandidateDto[];
}

/** Payload do POST /internal/messages/:id/analysis (worker Python → backend). */
export class PublishAnalysisDto {
  @IsOptional()
  @IsString()
  transcript?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  transcriptConfidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sessionSummary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coachNote?: string;

  @IsOptional()
  @IsIn(['neutro', 'alerta', 'oportunidade'])
  coachTone?: 'neutro' | 'alerta' | 'oportunidade';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalysisLinkDto)
  links!: AnalysisLinkDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalysisFactDto)
  facts!: AnalysisFactDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalysisUnknownDto)
  unknowns!: AnalysisUnknownDto[];
}
