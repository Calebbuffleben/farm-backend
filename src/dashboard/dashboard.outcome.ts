/**
 * Ciclo do gestor: quais alertas nascem, quando expiram, como a execução
 * vira movimento e o que a semana prova.
 *
 * Movimento é observação posterior. Não é venda salva nem receita.
 */

import {
  TEMPERATURE_ORDER,
  dealTemperature,
  type DealLevel,
  type DealStage,
  type DealTemperature,
  type TemperatureInput,
} from './deal-temperature';
import type { TimeWindow } from './dashboard.queries';

export type InterventionTrigger =
  | 'MANAGER_OWNER'
  | 'ESCALATE'
  | 'COOLING_CLOSE'
  | 'PRICE_OVER_AUTHORITY'
  | 'COMPETITOR_LATE';

export type InterventionStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'EXECUTED'
  | 'DISMISSED'
  | 'EXPIRED';

export type InterventionDecision = 'ASSUME' | 'DELEGATE' | 'DISMISS';
export type InterventionMovement = 'FAVORABLE' | 'NONE' | 'UNFAVORABLE';
export type AnalysisQuality = 'COMPLETE' | 'PARTIAL' | 'STALE';

export const VISIT_GAP_MS = 4 * 60 * 60 * 1000;

const STAGE_RANK: Record<DealStage, number> = {
  SONDAGEM: 0,
  NEGOCIACAO: 1,
  FECHAMENTO: 2,
  POS_VENDA: 3,
  SEM_NEGOCIO: -1,
};

const ACTIVE: InterventionStatus[] = ['OPEN', 'ACKNOWLEDGED'];

export interface InterventionCandidate {
  conversationId: string;
  stage: DealStage;
  temperature: DealTemperature;
  intent: DealLevel;
  urgency: DealLevel;
  stageConfidence: number;
  analysisQuality: AnalysisQuality;
  blockerSubtype: string | null;
  recommendedAction: string;
  recommendedKind: string;
  recommendedOwner: 'RTV' | 'MANAGER';
  dueAt: Date | null;
  managerGuidance: string | null;
  moneyHints: string[];
  evidenceMessageId: string;
  rtvUserId: string | null;
  hasCompetitor: boolean;
  discountPct: number | null;
  authorityPct: number | null;
}

export interface InterventionDraft extends InterventionCandidate {
  trigger: InterventionTrigger;
}

export interface StoredIntervention {
  id: string;
  conversationId: string;
  trigger: InterventionTrigger;
  status: InterventionStatus;
  decision: InterventionDecision | null;
  evidenceMessageId: string | null;
  stage: DealStage;
  temperature: DealTemperature;
  blockerSubtype: string | null;
  analysisQuality: AnalysisQuality;
  dueAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
  executionObservedAt: Date | null;
  expiredAt: Date | null;
  movement: InterventionMovement | null;
  movementAt: Date | null;
  rtvUserId: string | null;
}

export function hintedDiscountPct(hints: string[]): number | null {
  let max: number | null = null;
  for (const hint of hints) {
    for (const match of hint.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
      const n = Number(match[1].replace(',', '.'));
      if (!Number.isFinite(n)) continue;
      max = max == null ? n : Math.max(max, n);
    }
  }
  return max;
}

export function readDiscountAuthority(policy: unknown): number | null {
  if (!policy || typeof policy !== 'object') return null;
  const value = (policy as { discountAuthorityPct?: unknown }).discountAuthorityPct;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function triggersFor(candidate: InterventionCandidate): InterventionTrigger[] {
  if (candidate.analysisQuality === 'STALE' || candidate.stage === 'SEM_NEGOCIO') {
    return [];
  }
  const triggers: InterventionTrigger[] = [];
  if (candidate.recommendedKind === 'escalar_gestor') triggers.push('ESCALATE');
  else if (candidate.recommendedOwner === 'MANAGER') triggers.push('MANAGER_OWNER');
  if (candidate.temperature === 'COOLING' && candidate.stage === 'FECHAMENTO') {
    triggers.push('COOLING_CLOSE');
  }
  if (
    candidate.blockerSubtype === 'preco' &&
    candidate.authorityPct != null &&
    candidate.discountPct != null &&
    candidate.discountPct > candidate.authorityPct
  ) {
    triggers.push('PRICE_OVER_AUTHORITY');
  }
  if (
    candidate.hasCompetitor &&
    (candidate.temperature === 'HOT' || candidate.stage === 'FECHAMENTO')
  ) {
    triggers.push('COMPETITOR_LATE');
  }
  return triggers;
}

export function planSync(
  candidates: InterventionCandidate[],
  existing: StoredIntervention[],
  now: Date,
): { create: InterventionDraft[]; expireIds: string[] } {
  const create: InterventionDraft[] = [];
  const expireIds: string[] = [];
  const byKey = new Map<string, StoredIntervention[]>();
  for (const row of existing) {
    const key = `${row.conversationId}|${row.trigger}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  for (const candidate of candidates) {
    for (const trigger of triggersFor(candidate)) {
      const history = byKey.get(`${candidate.conversationId}|${trigger}`) ?? [];
      const active = history.find((row) => ACTIVE.includes(row.status));
      if (active) continue;
      const latest = history[0];
      if (latest && latest.evidenceMessageId === candidate.evidenceMessageId) continue;
      create.push({ ...candidate, trigger });
    }
  }

  for (const row of existing) {
    if (!ACTIVE.includes(row.status)) continue;
    if (row.executionObservedAt) continue;
    if (!row.dueAt || row.dueAt.getTime() > now.getTime()) continue;
    expireIds.push(row.id);
  }

  return { create, expireIds };
}

export interface MovementInput {
  birthStage: DealStage;
  birthTemperature: DealTemperature;
  currentStage: DealStage;
  currentTemperature: DealTemperature;
  birthBlocker: string | null;
  currentBlocker: string | null;
  dueAt: Date | null;
  now: Date;
  executed: boolean;
  newCritical: boolean;
  newCompetitor: boolean;
  followupResolved: boolean;
}

export function classifyMovement(input: MovementInput): {
  movement: InterventionMovement | null;
  note: string | null;
} {
  const unfavorable: string[] = [];
  const favorable: string[] = [];

  if (input.birthStage !== 'SEM_NEGOCIO' && input.currentStage === 'SEM_NEGOCIO') {
    unfavorable.push('Negócio saiu do pipeline');
  } else if (
    input.currentStage !== 'SEM_NEGOCIO' &&
    STAGE_RANK[input.currentStage] < STAGE_RANK[input.birthStage]
  ) {
    unfavorable.push('Estágio regrediu');
  } else if (STAGE_RANK[input.currentStage] > STAGE_RANK[input.birthStage]) {
    favorable.push('Estágio avançou');
  }

  const birthTemp = TEMPERATURE_ORDER[input.birthTemperature];
  const currentTemp = TEMPERATURE_ORDER[input.currentTemperature];
  if (currentTemp < birthTemp) favorable.push('Temperatura melhorou');
  else if (currentTemp > birthTemp) unfavorable.push('Temperatura piorou');

  if (input.birthBlocker && !input.currentBlocker) favorable.push('Gargalo deixou de aparecer');
  if (input.newCritical) unfavorable.push('Risco crítico novo');
  if (input.newCompetitor) unfavorable.push('Concorrente novo');
  if (input.followupResolved) favorable.push('Follow-up resolvido');

  if (unfavorable.length) {
    return { movement: 'UNFAVORABLE', note: unfavorable.join(' · ') };
  }
  if (favorable.length) {
    return { movement: 'FAVORABLE', note: favorable.join(' · ') };
  }

  const duePassed = input.dueAt != null && input.dueAt.getTime() <= input.now.getTime();
  const stillCool =
    (input.currentTemperature === 'COOLING' || input.currentTemperature === 'COLD') &&
    input.currentTemperature === input.birthTemperature;
  if (duePassed) return { movement: 'NONE', note: 'Prazo venceu sem mudança' };
  if (input.executed && stillCool) return { movement: 'NONE', note: 'Continua esfriando' };
  return { movement: null, note: null };
}

export function temperatureOf(input: TemperatureInput, now: Date): DealTemperature {
  return dealTemperature(input, now);
}

function inWindow(at: Date | null, window: TimeWindow): boolean {
  if (!at) return false;
  const t = at.getTime();
  return t >= window.from.getTime() && t < window.to.getTime();
}

export interface Scoreboard<T> {
  asked: T[];
  decided: T[];
  observed: T[];
  moved: T[];
  expired: T[];
  medianReactionHours: number | null;
  partialInMoved: number;
}

export function buildScoreboard<T extends StoredIntervention>(
  rows: T[],
  window: TimeWindow,
): Scoreboard<T> {
  const asked = rows.filter((row) => inWindow(row.createdAt, window));
  const decided = rows.filter(
    (row) =>
      (row.decision === 'ASSUME' || row.decision === 'DELEGATE') &&
      inWindow(row.decidedAt, window),
  );
  const observed = rows.filter((row) => inWindow(row.executionObservedAt, window));
  const moved = rows.filter(
    (row) =>
      row.movement === 'FAVORABLE' &&
      row.executionObservedAt != null &&
      inWindow(row.movementAt ?? row.executionObservedAt, window),
  );
  const expired = rows.filter((row) => row.status === 'EXPIRED' && inWindow(row.expiredAt, window));
  const samples = observed
    .map((row) =>
      row.executionObservedAt
        ? (row.executionObservedAt.getTime() - row.createdAt.getTime()) / 3_600_000
        : null,
    )
    .filter((hours): hours is number => hours != null && hours >= 0)
    .sort((a, b) => a - b);
  const medianReactionHours = samples.length
    ? samples.length % 2 === 1
      ? samples[Math.floor(samples.length / 2)]
      : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2
    : null;
  return {
    asked,
    decided,
    observed,
    moved,
    expired,
    medianReactionHours,
    partialInMoved: moved.filter((row) => row.analysisQuality !== 'COMPLETE').length,
  };
}

export interface SnapshotPoint {
  conversationId: string;
  occurredAt: Date;
  stage: DealStage;
  temperature: DealTemperature;
}

export interface SinceSummary {
  from: string;
  newDecisions: number;
  advanced: number;
  cooled: number;
  executed: number;
  expired: number;
  threats: number;
}

export function buildSince(input: {
  since: Date;
  interventions: StoredIntervention[];
  snapshots: SnapshotPoint[];
  threats: number;
}): SinceSummary {
  const sinceMs = input.since.getTime();
  const advanced = new Set<string>();
  const cooled = new Set<string>();
  const byConversation = new Map<string, SnapshotPoint[]>();
  for (const point of input.snapshots) {
    const list = byConversation.get(point.conversationId);
    if (list) list.push(point);
    else byConversation.set(point.conversationId, [point]);
  }
  for (const [conversationId, points] of byConversation) {
    points.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].occurredAt.getTime() <= sinceMs) continue;
      const prev = points[i - 1];
      const current = points[i];
      if (STAGE_RANK[current.stage] > STAGE_RANK[prev.stage]) advanced.add(conversationId);
      if (TEMPERATURE_ORDER[current.temperature] > TEMPERATURE_ORDER[prev.temperature]) {
        cooled.add(conversationId);
      }
    }
  }
  return {
    from: input.since.toISOString(),
    newDecisions: input.interventions.filter((row) => row.createdAt.getTime() > sinceMs).length,
    advanced: advanced.size,
    cooled: cooled.size,
    executed: input.interventions.filter(
      (row) => row.executionObservedAt != null && row.executionObservedAt.getTime() > sinceMs,
    ).length,
    expired: input.interventions.filter(
      (row) => row.expiredAt != null && row.expiredAt.getTime() > sinceMs,
    ).length,
    threats: input.threats,
  };
}

export function nextVisit(
  prev: { visitStartedAt: Date; visibleSinceAt: Date | null } | null,
  now: Date,
): { visitStartedAt: Date; visibleSinceAt: Date | null; since: Date | null } {
  if (!prev) {
    return { visitStartedAt: now, visibleSinceAt: null, since: null };
  }
  if (now.getTime() - prev.visitStartedAt.getTime() > VISIT_GAP_MS) {
    return {
      visitStartedAt: now,
      visibleSinceAt: prev.visitStartedAt,
      since: prev.visitStartedAt,
    };
  }
  return {
    visitStartedAt: prev.visitStartedAt,
    visibleSinceAt: prev.visibleSinceAt,
    since: prev.visibleSinceAt,
  };
}

export function shouldCaptureSnapshot(
  previous: { stage: DealStage; temperature: string; blockerSubtype: string | null } | null,
  next: { stage: DealStage; temperature: string; blockerSubtype: string | null },
): boolean {
  if (!previous) return true;
  return (
    previous.stage !== next.stage ||
    previous.temperature !== next.temperature ||
    (previous.blockerSubtype ?? null) !== (next.blockerSubtype ?? null)
  );
}
