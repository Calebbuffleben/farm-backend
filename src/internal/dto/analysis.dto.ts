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

export const DEAL_STAGES = [
  'SONDAGEM',
  'NEGOCIACAO',
  'FECHAMENTO',
  'POS_VENDA',
  'SEM_NEGOCIO',
] as const;
export const DEAL_LEVELS = ['BAIXA', 'MEDIA', 'ALTA'] as const;
export const NEXT_ACTION_KINDS = [
  'proposta',
  'followup',
  'logistica',
  'ligar',
  'escalar_gestor',
  'aguardar',
  'pos_venda',
] as const;

/** Situação do negócio da conversa inteira — vira DealBrief 1:1 por Conversation. */
export class AnalysisDealDto {
  @IsIn(DEAL_STAGES)
  stage!: (typeof DEAL_STAGES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  stageConfidence?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(600)
  contextSummary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  producerPosition?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  dealChange?: string | null;

  @IsIn(DEAL_LEVELS)
  intent!: (typeof DEAL_LEVELS)[number];

  @IsIn(DEAL_LEVELS)
  urgency!: (typeof DEAL_LEVELS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(400)
  painPoint?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  nextAction!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  nextActionReason?: string | null;

  @IsOptional()
  @IsIn(['RTV', 'MANAGER'])
  nextActionOwner?: 'RTV' | 'MANAGER';

  @IsIn(NEXT_ACTION_KINDS)
  nextActionKind!: (typeof NEXT_ACTION_KINDS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nextActionDueHint?: string | null;

  @IsOptional()
  @IsISO8601()
  nextActionDueAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  suggestedReply?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  managerGuidance?: string | null;

  @IsOptional()
  @IsIn(['COMPLETE', 'PARTIAL', 'STALE'])
  analysisQuality?: 'COMPLETE' | 'PARTIAL' | 'STALE';

  @IsOptional()
  @IsString()
  @MaxLength(60)
  blockerSubtype?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  products?: string[];
}

/** Payload do POST /internal/messages/:id/analysis (worker Python → backend). */
export class PublishAnalysisDto {
  /** Ausente = worker não conseguiu classificar; o brief anterior é preservado. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AnalysisDealDto)
  deal?: AnalysisDealDto;

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
