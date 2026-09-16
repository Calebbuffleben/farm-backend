/**
 * Centro de Comando — agregação pura sobre DealBrief + última mensagem.
 *
 * Sem Prisma: o service carrega DealRow[] e chama buildCommand. Sem R$: o
 * pipeline mostra contagens e `moneyHints` (texto) — valor apurado só com ERP.
 */

import {
  dealTemperature,
  isUnanswered,
  TEMPERATURE_ORDER,
  type DealLevel,
  type DealStage,
  type DealTemperature,
} from './deal-temperature';

export const DEAL_STAGES: DealStage[] = [
  'SONDAGEM',
  'NEGOCIACAO',
  'FECHAMENTO',
  'POS_VENDA',
  'SEM_NEGOCIO',
];

export interface DealRow {
  conversationId: string;
  producerId: string | null;
  producerName: string | null;
  producerPhone: string | null;
  farmNames: string[];
  rtvUserId: string | null;
  rtvName: string | null;
  stage: DealStage;
  stageConfidence: number;
  contextSummary: string;
  producerPosition: string | null;
  dealChange: string | null;
  intent: DealLevel;
  urgency: DealLevel;
  painPoint: string | null;
  nextAction: string;
  nextActionReason: string | null;
  nextActionOwner: 'RTV' | 'MANAGER';
  nextActionKind: string;
  nextActionDueHint: string | null;
  nextActionDueAt: Date | null;
  suggestedReply: string | null;
  managerGuidance: string | null;
  analysisQuality: 'COMPLETE' | 'PARTIAL' | 'STALE';
  blockerSubtype: string | null;
  products: string[];
  updatedAt: Date;
  lastMessageAt: Date | null;
  lastDirection: 'IN' | 'OUT' | null;
  /** Fatos abertos da conversa (já filtrados pelo service). */
  openComplaints: number;
  overdueFollowups: number;
  moneyHints: string[];
  criticalFacts: string[];
  /** Cortes do dashboard (mesmos filtros das 5 perguntas). */
  crops: string[];
  regions: string[];
  productKeys: string[];
  farmIds: string[];
}

export interface DealCuts {
  rtvUserId?: string;
  farmId?: string;
  crop?: string;
  region?: string;
  productKey?: string;
}

export interface DealCard {
  conversationId: string;
  producerName: string | null;
  producerPhone: string | null;
  farmNames: string[];
  rtvUserId: string | null;
  rtvName: string | null;
  stage: DealStage;
  temperature: DealTemperature;
  intent: DealLevel;
  urgency: DealLevel;
  contextSummary: string;
  producerPosition: string | null;
  dealChange: string | null;
  painPoint: string | null;
  nextAction: string;
  nextActionReason: string | null;
  nextActionOwner: 'RTV' | 'MANAGER';
  nextActionKind: string;
  nextActionDueHint: string | null;
  nextActionDueAt: string | null;
  suggestedReply: string | null;
  managerGuidance: string | null;
  analysisQuality: 'COMPLETE' | 'PARTIAL' | 'STALE';
  blockerSubtype: string | null;
  products: string[];
  moneyHints: string[];
  criticalFacts: string[];
  lastMessageAt: string | null;
  lastDirection: 'IN' | 'OUT' | null;
  unanswered: boolean;
  updatedAt: string;
}

export type AttentionReason =
  | 'hot_with_pain'
  | 'cooling_late_stage'
  | 'unanswered'
  | 'next_action_overdue'
  | 'followup_overdue'
  | 'manager_escalation';

export interface AttentionItem extends DealCard {
  reasons: AttentionReason[];
  priority: number;
}

export interface RadarRow {
  rtvUserId: string | null;
  rtvName: string;
  deals: number;
  hot: number;
  warm: number;
  cooling: number;
  cold: number;
  complaints: number;
  overdueFollowups: number;
  unanswered: number;
  /** Quanto o RTV precisa de atenção do gestor — maior = pior. */
  score: number;
}

export function applyDealCuts(rows: DealRow[], cuts: DealCuts): DealRow[] {
  return rows.filter((row) => {
    if (cuts.rtvUserId && row.rtvUserId !== cuts.rtvUserId) return false;
    if (cuts.farmId && !row.farmIds.includes(cuts.farmId)) return false;
    if (cuts.crop && !row.crops.includes(cuts.crop)) return false;
    if (cuts.region && !row.regions.includes(cuts.region)) return false;
    if (cuts.productKey && !row.productKeys.includes(cuts.productKey))
      return false;
    return true;
  });
}

export function toDealCard(row: DealRow, now: Date): DealCard {
  const temperature = dealTemperature(row, now);
  const unanswered = isUnanswered(row, now);
  return {
    conversationId: row.conversationId,
    producerName: row.producerName,
    producerPhone: row.producerPhone,
    farmNames: row.farmNames,
    rtvUserId: row.rtvUserId,
    rtvName: row.rtvName,
    stage: row.stage,
    temperature,
    intent: row.intent,
    urgency: row.urgency,
    contextSummary: row.contextSummary,
    producerPosition: row.producerPosition,
    dealChange: row.dealChange,
    painPoint: row.painPoint,
    nextAction: row.nextAction,
    nextActionReason: row.nextActionReason,
    nextActionOwner: row.nextActionOwner,
    nextActionKind: row.nextActionKind,
    nextActionDueHint: row.nextActionDueHint,
    nextActionDueAt: row.nextActionDueAt?.toISOString() ?? null,
    suggestedReply: row.suggestedReply,
    managerGuidance: row.managerGuidance,
    analysisQuality: row.analysisQuality,
    blockerSubtype: row.blockerSubtype,
    products: row.products,
    moneyHints: row.moneyHints,
    criticalFacts: row.criticalFacts,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastDirection: row.lastDirection,
    unanswered,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sortCards(a: DealCard, b: DealCard): number {
  const t = TEMPERATURE_ORDER[a.temperature] - TEMPERATURE_ORDER[b.temperature];
  if (t !== 0) return t;
  const al = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
  const bl = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
  return bl - al;
}

export function buildRadar(rows: DealRow[], now: Date): RadarRow[] {
  const map = new Map<string, RadarRow>();
  for (const row of rows) {
    const key = row.rtvUserId ?? '_none';
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        rtvUserId: row.rtvUserId,
        rtvName: row.rtvName ?? 'Sem RTV',
        deals: 0,
        hot: 0,
        warm: 0,
        cooling: 0,
        cold: 0,
        complaints: 0,
        overdueFollowups: 0,
        unanswered: 0,
        score: 0,
      };
      map.set(key, bucket);
    }
    const card = toDealCard(row, now);
    bucket.deals += 1;
    if (card.temperature === 'HOT') bucket.hot += 1;
    else if (card.temperature === 'WARM') bucket.warm += 1;
    else if (card.temperature === 'COOLING') bucket.cooling += 1;
    else bucket.cold += 1;
    bucket.complaints += row.openComplaints;
    bucket.overdueFollowups += row.overdueFollowups;
    if (card.unanswered) bucket.unanswered += 1;
  }
  return [...map.values()]
    .map((b) => ({
      ...b,
      // esfriando e sem resposta pesam mais que reclamação: é venda escapando
      score:
        b.cooling * 3 +
        b.unanswered * 3 +
        b.overdueFollowups * 2 +
        b.complaints,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hot - a.hot ||
        a.rtvName.localeCompare(b.rtvName, 'pt-BR'),
    );
}

export function buildPipeline(rows: DealRow[], now: Date) {
  const cards = rows.map((r) => toDealCard(r, now));
  const byStage = DEAL_STAGES.map((stage) => {
    const deals = cards.filter((c) => c.stage === stage).sort(sortCards);
    return { stage, count: deals.length, deals };
  });
  const blockerMap = new Map<string, DealCard[]>();
  for (const card of cards) {
    if (!card.blockerSubtype || card.stage === 'SEM_NEGOCIO') continue;
    const list = blockerMap.get(card.blockerSubtype);
    if (list) list.push(card);
    else blockerMap.set(card.blockerSubtype, [card]);
  }
  const byBlocker = [...blockerMap.entries()]
    .map(([blockerSubtype, deals]) => ({
      blockerSubtype,
      count: deals.length,
      deals: deals.sort(sortCards),
      moneyHints: [...new Set(deals.flatMap((d) => d.moneyHints))].slice(0, 12),
    }))
    .sort(
      (a, b) =>
        b.count - a.count || a.blockerSubtype.localeCompare(b.blockerSubtype),
    );
  return {
    open: cards.filter((c) => c.stage !== 'SEM_NEGOCIO').length,
    byStage,
    byBlocker,
  };
}

const REASON_WEIGHT: Record<AttentionReason, number> = {
  hot_with_pain: 5,
  next_action_overdue: 4,
  cooling_late_stage: 4,
  unanswered: 3,
  followup_overdue: 2,
  manager_escalation: 5,
};

export function buildAttention(
  rows: DealRow[],
  now: Date,
  limit = 30,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (row.stage === 'SEM_NEGOCIO') continue;
    const card = toDealCard(row, now);
    const reasons: AttentionReason[] = [];
    if (card.temperature === 'HOT' && card.painPoint)
      reasons.push('hot_with_pain');
    if (
      card.temperature === 'COOLING' &&
      (card.stage === 'NEGOCIACAO' || card.stage === 'FECHAMENTO')
    ) {
      reasons.push('cooling_late_stage');
    }
    if (card.unanswered) reasons.push('unanswered');
    if (row.nextActionDueAt && row.nextActionDueAt.getTime() <= now.getTime()) {
      reasons.push('next_action_overdue');
    }
    if (row.overdueFollowups > 0) reasons.push('followup_overdue');
    if (
      row.nextActionOwner === 'MANAGER' ||
      row.nextActionKind === 'escalar_gestor'
    ) {
      reasons.push('manager_escalation');
    }
    if (!reasons.length) continue;
    const priority = reasons.reduce((acc, r) => acc + REASON_WEIGHT[r], 0);
    items.push({ ...card, reasons, priority });
  }
  return items
    .sort((a, b) => b.priority - a.priority || sortCards(a, b))
    .slice(0, limit);
}

export function buildCommand(rows: DealRow[], now: Date) {
  const cards = rows.map((r) => toDealCard(r, now));
  const open = cards.filter((c) => c.stage !== 'SEM_NEGOCIO');
  return {
    summary: {
      deals: open.length,
      hot: open.filter((c) => c.temperature === 'HOT').length,
      cooling: open.filter((c) => c.temperature === 'COOLING').length,
      unanswered: open.filter((c) => c.unanswered).length,
      complaints: rows.reduce((acc, r) => acc + r.openComplaints, 0),
      overdueFollowups: rows.reduce((acc, r) => acc + r.overdueFollowups, 0),
    },
    attention: buildAttention(rows, now),
    radar: buildRadar(rows, now),
    pipeline: buildPipeline(rows, now),
  };
}
