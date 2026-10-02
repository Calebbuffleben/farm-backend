/**
 * Cobertura da carteira e demanda. Hectare ordena; não vira R$.
 * Concorrente fica no headline — sem agrupar nome por regex.
 */

import type { DealStage } from './deal-temperature';
import {
  inRange,
  QUESTION_ITEM_CAP,
  type FactRow,
  type TimeWindow,
} from './dashboard.queries';

export interface SilentFarmInput {
  farmId: string;
  farmName: string;
  producerName: string;
  region: string | null;
  crop: string | null;
  seasonLabel: string | null;
  areaHa: number | null;
  lastFactAt: Date | null;
}

export interface SilentFarmCard {
  farmId: string;
  farmName: string;
  producerName: string;
  region: string | null;
  crop: string | null;
  seasonLabel: string | null;
  areaHa: number | null;
  lastFactAt: string | null;
  daysSilent: number | null;
}

const SILENT_CAP = 30;

export function buildSilentFarms(
  rows: SilentFarmInput[],
  silentBefore: Date,
  now: Date,
): SilentFarmCard[] {
  return rows
    .filter((row) => !row.lastFactAt || row.lastFactAt.getTime() < silentBefore.getTime())
    .map((row) => ({
      farmId: row.farmId,
      farmName: row.farmName,
      producerName: row.producerName,
      region: row.region,
      crop: row.crop,
      seasonLabel: row.seasonLabel,
      areaHa: row.areaHa,
      lastFactAt: row.lastFactAt ? row.lastFactAt.toISOString() : null,
      daysSilent: row.lastFactAt
        ? Math.floor((now.getTime() - row.lastFactAt.getTime()) / 86_400_000)
        : null,
    }))
    .sort(
      (a, b) =>
        (b.areaHa ?? -1) - (a.areaHa ?? -1) ||
        a.farmName.localeCompare(b.farmName, 'pt-BR') ||
        (a.crop ?? '').localeCompare(b.crop ?? '', 'pt-BR'),
    )
    .slice(0, SILENT_CAP);
}

export interface OpportunityGroup {
  product: string;
  crop: string;
  region: string;
  current: number;
  previous: number;
  delta: number;
  growing: boolean;
  items: FactRow[];
}

export function buildOpportunities(
  rows: FactRow[],
  window: TimeWindow,
): { count: number; growing: number; groups: OpportunityGroup[] } {
  const current = rows.filter(
    (row) => row.kind === 'OPORTUNIDADE' && inRange(row.occurredAt, window.from, window.to),
  );
  const previousCount = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'OPORTUNIDADE' || !inRange(row.occurredAt, window.previousFrom, window.previousTo)) {
      continue;
    }
    const key = groupKey(row);
    previousCount.set(key, (previousCount.get(key) ?? 0) + 1);
  }
  const grouped = new Map<string, FactRow[]>();
  for (const row of current) {
    const key = groupKey(row);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  const groups = [...grouped.entries()]
    .map(([key, items]) => {
      const [product, crop, region] = key.split('|');
      const prev = previousCount.get(key) ?? 0;
      return {
        product,
        crop,
        region,
        current: items.length,
        previous: prev,
        delta: items.length - prev,
        growing: items.length > prev,
        items: items.slice(0, QUESTION_ITEM_CAP),
      };
    })
    .sort((a, b) => b.delta - a.delta || b.current - a.current);
  return {
    count: current.length,
    growing: groups.filter((group) => group.growing).length,
    groups: groups.slice(0, QUESTION_ITEM_CAP),
  };
}

function groupKey(row: FactRow): string {
  return `${row.productKey ?? '—'}|${row.crop ?? '—'}|${row.region ?? '—'}`;
}

const STAGE_WEIGHT: Record<DealStage, number> = {
  FECHAMENTO: 3,
  NEGOCIACAO: 2,
  SONDAGEM: 1,
  POS_VENDA: 1,
  SEM_NEGOCIO: 0,
};

export interface CompetitiveGroup {
  product: string;
  stage: DealStage | null;
  weight: number;
  count: number;
  headlines: string[];
  items: FactRow[];
}

export function buildCompetitive(
  rows: FactRow[],
  stageByConversation: Map<string, DealStage>,
  window: TimeWindow,
): { count: number; groups: CompetitiveGroup[] } {
  const current = rows.filter(
    (row) => row.kind === 'CONCORRENTE' && inRange(row.occurredAt, window.from, window.to),
  );
  const grouped = new Map<string, FactRow[]>();
  for (const row of current) {
    const stage = stageByConversation.get(row.conversationId) ?? null;
    const key = `${row.productKey ?? '—'}|${stage ?? '—'}`;
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  const groups = [...grouped.entries()]
    .map(([key, items]) => {
      const [product, stageRaw] = key.split('|');
      const stage = stageRaw === '—' ? null : (stageRaw as DealStage);
      return {
        product,
        stage,
        weight: stage ? STAGE_WEIGHT[stage] : 1,
        count: items.length,
        headlines: [...new Set(items.map((item) => item.headline))].slice(0, 4),
        items: items.slice(0, QUESTION_ITEM_CAP),
      };
    })
    .sort((a, b) => b.weight - a.weight || b.count - a.count || a.product.localeCompare(b.product, 'pt-BR'));
  return { count: current.length, groups: groups.slice(0, QUESTION_ITEM_CAP) };
}
