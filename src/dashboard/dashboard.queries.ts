/**
 * Agregação pura das 5 perguntas do gestor.
 *
 * Sem Prisma: o service carrega as linhas e chama buildHome. moneyHint NÃO é R$
 * — é pista de texto ("50 galões", "5% desconto").
 */

export type FactKind =
  | 'OBJECAO'
  | 'RISCO'
  | 'OPORTUNIDADE'
  | 'FOLLOWUP'
  | 'CONCORRENTE';
export type FactSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface FactRow {
  id: string;
  kind: FactKind;
  subtype: string;
  severity: FactSeverity;
  headline: string;
  moneyHint: string | null;
  dueHintText: string | null;
  dueAt: Date | null;
  occurredAt: Date;
  farmId: string | null;
  farmName: string | null;
  region: string | null;
  crop: string | null;
  productKey: string | null;
  rtvUserId: string | null;
  rtvName: string | null;
  producerName: string | null;
  evidenceMessageId: string;
  evidenceSpan: string | null;
  conversationId: string;
}

export interface DashboardCuts {
  rtvUserId?: string;
  farmId?: string;
  crop?: string;
  region?: string;
  productKey?: string;
}

export interface TimeWindow {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  days: number;
}

const SEVERITY_RANK: Record<FactSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export function rollingWindow(now: Date, days: number): TimeWindow {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7;
  const to = now;
  const from = new Date(now.getTime() - safeDays * 86_400_000);
  return {
    from,
    to,
    previousFrom: new Date(from.getTime() - safeDays * 86_400_000),
    previousTo: from,
    days: safeDays,
  };
}

export function inRange(at: Date, from: Date, to: Date): boolean {
  const t = at.getTime();
  return t >= from.getTime() && t < to.getTime();
}

export function applyCuts(rows: FactRow[], cuts: DashboardCuts): FactRow[] {
  return rows.filter((row) => {
    if (cuts.rtvUserId && row.rtvUserId !== cuts.rtvUserId) return false;
    if (cuts.farmId && row.farmId !== cuts.farmId) return false;
    if (cuts.crop && row.crop !== cuts.crop) return false;
    if (cuts.region && row.region !== cuts.region) return false;
    if (cuts.productKey && row.productKey !== cuts.productKey) return false;
    return true;
  });
}

function sortFacts(a: FactRow, b: FactRow): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  return b.occurredAt.getTime() - a.occurredAt.getTime();
}

/** Dinheiro em risco: RISCO, ou qualquer fato com pista de dinheiro que não seja oportunidade. */
export function isMoneyRisk(row: FactRow): boolean {
  if (row.kind === 'RISCO') return true;
  if (row.kind === 'OPORTUNIDADE') return false;
  return Boolean(row.moneyHint);
}

export function isOverdueFollowup(row: FactRow, now: Date): boolean {
  return row.kind === 'FOLLOWUP' && row.dueAt !== null && row.dueAt.getTime() <= now.getTime();
}

export function isFollowupOnRadar(row: FactRow, now: Date, window: TimeWindow): boolean {
  if (row.kind !== 'FOLLOWUP') return false;
  if (isOverdueFollowup(row, now)) return true;
  if (row.dueAt && inRange(row.dueAt, window.from, window.to)) return true;
  if (!row.dueAt && inRange(row.occurredAt, window.from, window.to)) return true;
  return false;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
}

export function collectCuts(rows: FactRow[]) {
  const rtvs = new Map<string, string>();
  const farms = new Map<string, string>();
  for (const row of rows) {
    if (row.rtvUserId) rtvs.set(row.rtvUserId, row.rtvName ?? row.rtvUserId);
    if (row.farmId) farms.set(row.farmId, row.farmName ?? row.farmId);
  }
  return {
    rtvs: [...rtvs.entries()].map(([id, name]) => ({ id, name })),
    farms: [...farms.entries()].map(([id, name]) => ({ id, name })),
    regions: uniqueSorted(rows.map((r) => r.region)),
    crops: uniqueSorted(rows.map((r) => r.crop)),
    products: uniqueSorted(rows.map((r) => r.productKey)),
  };
}

export function buildHome(
  rows: FactRow[],
  now: Date,
  window: TimeWindow,
  unknownPending: number,
) {
  const current = rows.filter((r) => inRange(r.occurredAt, window.from, window.to));
  const previous = rows.filter((r) =>
    inRange(r.occurredAt, window.previousFrom, window.previousTo),
  );

  const moneyItems = current.filter(isMoneyRisk).sort(sortFacts);

  const groupKey = (r: FactRow) => `${r.crop ?? '—'}|${r.region ?? '—'}`;
  const currentObj = current.filter((r) => r.kind === 'OBJECAO');
  const prevObjCount = new Map<string, number>();
  for (const row of previous.filter((r) => r.kind === 'OBJECAO')) {
    const key = groupKey(row);
    prevObjCount.set(key, (prevObjCount.get(key) ?? 0) + 1);
  }
  const objGroupsMap = new Map<string, FactRow[]>();
  for (const row of currentObj) {
    const key = groupKey(row);
    const list = objGroupsMap.get(key);
    if (list) list.push(row);
    else objGroupsMap.set(key, [row]);
  }
  const objectionGroups = [...objGroupsMap.entries()]
    .map(([key, items]) => {
      const [crop, region] = key.split('|');
      const currentCount = items.length;
      const prevCount = prevObjCount.get(key) ?? 0;
      return {
        crop,
        region,
        current: currentCount,
        previous: prevCount,
        delta: currentCount - prevCount,
        growing: currentCount > prevCount,
        items: items.sort(sortFacts),
      };
    })
    .sort((a, b) => b.delta - a.delta || b.current - a.current);

  const followupItems = rows
    .filter((r) => isFollowupOnRadar(r, now, window))
    .sort((a, b) => {
      const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      return sortFacts(a, b);
    });
  const overdueCount = followupItems.filter((r) => isOverdueFollowup(r, now)).length;

  const competitorItems = current.filter((r) => r.kind === 'CONCORRENTE').sort(sortFacts);

  const rtvMap = new Map<
    string,
    {
      rtvUserId: string | null;
      rtvName: string;
      critical: number;
      warning: number;
      overdue: number;
      competitor: number;
      objections: number;
      items: FactRow[];
    }
  >();
  const rtvRows = [
    ...current,
    ...rows.filter((r) => isOverdueFollowup(r, now) && !inRange(r.occurredAt, window.from, window.to)),
  ];
  for (const row of rtvRows) {
    const key = row.rtvUserId ?? '_none';
    let bucket = rtvMap.get(key);
    if (!bucket) {
      bucket = {
        rtvUserId: row.rtvUserId,
        rtvName: row.rtvName ?? 'Sem RTV',
        critical: 0,
        warning: 0,
        overdue: 0,
        competitor: 0,
        objections: 0,
        items: [],
      };
      rtvMap.set(key, bucket);
    }
    bucket.items.push(row);
    if (row.severity === 'CRITICAL') bucket.critical += 1;
    if (row.severity === 'WARNING') bucket.warning += 1;
    if (isOverdueFollowup(row, now)) bucket.overdue += 1;
    if (row.kind === 'CONCORRENTE') bucket.competitor += 1;
    if (row.kind === 'OBJECAO') bucket.objections += 1;
  }
  const rtvHelp = [...rtvMap.values()]
    .map((b) => ({
      ...b,
      score: b.critical * 4 + b.overdue * 3 + b.warning * 2 + b.competitor + b.objections,
      items: b.items.sort(sortFacts),
    }))
    .sort((a, b) => b.score - a.score || a.rtvName.localeCompare(b.rtvName, 'pt-BR'));

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previousFrom: window.previousFrom.toISOString(),
      previousTo: window.previousTo.toISOString(),
      days: window.days,
    },
    unknownPending,
    cuts: collectCuts(rows),
    questions: {
      moneyRisk: { count: moneyItems.length, items: moneyItems },
      objections: {
        count: currentObj.length,
        growing: objectionGroups.filter((g) => g.growing).length,
        groups: objectionGroups,
      },
      followups: {
        count: followupItems.length,
        overdue: overdueCount,
        items: followupItems,
      },
      competitor: { count: competitorItems.length, items: competitorItems },
      rtvHelp: { count: rtvHelp.length, items: rtvHelp },
    },
  };
}
