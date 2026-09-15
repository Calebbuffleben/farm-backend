/**
 * Temperatura do negócio — regra determinística, não opinião do LLM.
 *
 * Entrada: brief (intenção/urgência/estágio) + tempo desde o último contato +
 * quem falou por último. Limiares fixos (ponytail): o upgrade é por tenant
 * quando algum gestor pedir; até lá, 3/7/21 dias cobrem a safra.
 */

export type DealStage =
  | 'SONDAGEM'
  | 'NEGOCIACAO'
  | 'FECHAMENTO'
  | 'POS_VENDA'
  | 'SEM_NEGOCIO';
export type DealLevel = 'BAIXA' | 'MEDIA' | 'ALTA';
export type DealTemperature = 'HOT' | 'WARM' | 'COOLING' | 'COLD';

export const HOT_MAX_DAYS = 3;
export const WARM_MAX_DAYS = 7;
export const COOLING_MAX_DAYS = 21;
/** Produtor falou e ninguém respondeu há mais que isto → esfriando. */
export const UNANSWERED_IN_HOURS = 48;

export const TEMPERATURE_ORDER: Record<DealTemperature, number> = {
  HOT: 0,
  WARM: 1,
  COOLING: 2,
  COLD: 3,
};

export interface TemperatureInput {
  stage: DealStage;
  intent: DealLevel;
  urgency: DealLevel;
  lastMessageAt: Date | null;
  lastDirection: 'IN' | 'OUT' | null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function daysSince(at: Date | null, now: Date): number {
  if (!at) return Number.POSITIVE_INFINITY;
  return (now.getTime() - at.getTime()) / DAY_MS;
}

/** Produtor mandou a última mensagem e ficou sem resposta além do limiar. */
export function isUnanswered(input: TemperatureInput, now: Date): boolean {
  if (input.lastDirection !== 'IN' || !input.lastMessageAt) return false;
  return now.getTime() - input.lastMessageAt.getTime() > UNANSWERED_IN_HOURS * HOUR_MS;
}

export function dealTemperature(input: TemperatureInput, now: Date): DealTemperature {
  if (input.stage === 'SEM_NEGOCIO') return 'COLD';
  const days = daysSince(input.lastMessageAt, now);
  if (days > COOLING_MAX_DAYS) return 'COLD';
  if (isUnanswered(input, now)) return 'COOLING';
  const eager = input.intent === 'ALTA' || input.urgency === 'ALTA';
  if (eager && days <= HOT_MAX_DAYS) return 'HOT';
  if (days <= WARM_MAX_DAYS) return 'WARM';
  return 'COOLING';
}
