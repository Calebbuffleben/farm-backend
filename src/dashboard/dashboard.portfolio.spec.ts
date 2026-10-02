import { buildCompetitive, buildOpportunities, buildSilentFarms } from './dashboard.portfolio';
import { rollingWindow, type FactRow } from './dashboard.queries';

const NOW = new Date('2026-10-02T15:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function fact(overrides: Partial<FactRow> = {}): FactRow {
  return {
    id: 'fact-1',
    kind: 'OPORTUNIDADE',
    subtype: 'interesse_produto',
    severity: 'INFO',
    headline: 'Pediu cotação de biológico',
    moneyHint: null,
    dueHintText: null,
    dueAt: null,
    occurredAt: daysAgo(1),
    farmId: 'farm-1',
    farmName: 'Chapadão',
    region: 'Norte',
    crop: 'soja',
    productKey: 'biologico-x',
    rtvUserId: 'rtv-1',
    rtvName: 'Ana',
    producerName: 'João',
    evidenceMessageId: 'msg-1',
    evidenceSpan: null,
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('buildSilentFarms', () => {
  it('ordena pelo hectare e trata quem nunca conversou', () => {
    const rows = buildSilentFarms(
      [
        {
          farmId: 'small',
          farmName: 'Pequena',
          producerName: 'Ana',
          region: 'Sul',
          crop: 'milho',
          seasonLabel: '2026/27',
          areaHa: 40,
          lastFactAt: daysAgo(30),
        },
        {
          farmId: 'big',
          farmName: 'Grande',
          producerName: 'Beto',
          region: 'Norte',
          crop: 'soja',
          seasonLabel: '2026/27',
          areaHa: 800,
          lastFactAt: null,
        },
        {
          farmId: 'active',
          farmName: 'Ativa',
          producerName: 'Cia',
          region: 'Norte',
          crop: 'soja',
          seasonLabel: '2026/27',
          areaHa: 1000,
          lastFactAt: daysAgo(1),
        },
      ],
      daysAgo(7),
      NOW,
    );
    expect(rows.map((row) => row.farmId)).toEqual(['big', 'small']);
    expect(rows[0].daysSilent).toBeNull();
    expect(rows[1].daysSilent).toBe(30);
  });
});

describe('buildOpportunities', () => {
  it('agrupa demanda por produto, cultura e região e marca crescimento', () => {
    const window = rollingWindow(NOW, 7);
    const result = buildOpportunities(
      [
        fact({ id: 'a' }),
        fact({ id: 'b', occurredAt: daysAgo(2) }),
        fact({ id: 'old', occurredAt: daysAgo(10) }),
        fact({
          id: 'other',
          productKey: 'semente-y',
          crop: 'milho',
          region: 'Sul',
        }),
      ],
      window,
    );
    expect(result.count).toBe(3);
    expect(result.growing).toBe(2);
    expect(result.groups[0]).toMatchObject({
      product: 'biologico-x',
      crop: 'soja',
      region: 'Norte',
      current: 2,
      previous: 1,
    });
  });
});

describe('buildCompetitive', () => {
  it('pesa menção em fechamento acima de sondagem e preserva o headline', () => {
    const window = rollingWindow(NOW, 7);
    const result = buildCompetitive(
      [
        fact({
          id: 'close',
          kind: 'CONCORRENTE',
          conversationId: 'conv-close',
          headline: 'Cotou com a AgroSul',
          productKey: 'biologico-x',
        }),
        fact({
          id: 'early',
          kind: 'CONCORRENTE',
          conversationId: 'conv-early',
          headline: 'Citou outro fornecedor',
          productKey: 'biologico-x',
        }),
      ],
      new Map([
        ['conv-close', 'FECHAMENTO'],
        ['conv-early', 'SONDAGEM'],
      ]),
      window,
    );
    expect(result.count).toBe(2);
    expect(result.groups[0]).toMatchObject({
      stage: 'FECHAMENTO',
      weight: 3,
      headlines: ['Cotou com a AgroSul'],
    });
  });
});
