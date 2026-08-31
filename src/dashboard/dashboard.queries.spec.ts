import {
  applyCuts,
  buildHome,
  isMoneyRisk,
  rollingWindow,
  type FactRow,
} from './dashboard.queries';

const NOW = new Date('2026-08-27T18:00:00.000Z');
const WINDOW = rollingWindow(NOW, 7);

function fact(partial: Partial<FactRow> & Pick<FactRow, 'id' | 'kind' | 'headline'>): FactRow {
  return {
    subtype: 'outro',
    severity: 'INFO',
    moneyHint: null,
    dueHintText: null,
    dueAt: null,
    occurredAt: new Date('2026-08-26T12:00:00.000Z'),
    farmId: 'farm-1',
    farmName: 'Chapadão',
    region: 'MT',
    crop: 'soja',
    productKey: null,
    rtvUserId: 'rtv-1',
    rtvName: 'Ana',
    producerName: 'João',
    evidenceMessageId: 'msg-1',
    evidenceSpan: 'trecho',
    conversationId: 'conv-1',
    ...partial,
  };
}

describe('dashboard.queries', () => {
  it('money risk includes RISCO and moneyHint, excludes OPORTUNIDADE', () => {
    expect(isMoneyRisk(fact({ id: '1', kind: 'RISCO', headline: 'risco' }))).toBe(true);
    expect(
      isMoneyRisk(
        fact({ id: '2', kind: 'OBJECAO', headline: 'preço', moneyHint: '5% desconto' }),
      ),
    ).toBe(true);
    expect(
      isMoneyRisk(
        fact({
          id: '3',
          kind: 'OPORTUNIDADE',
          headline: 'pedido',
          moneyHint: '50 galões',
        }),
      ),
    ).toBe(false);
  });

  it('answers the five questions from open facts', () => {
    const rows: FactRow[] = [
      fact({
        id: 'risk',
        kind: 'RISCO',
        severity: 'CRITICAL',
        headline: 'Janela fechando',
        moneyHint: '30 ha',
      }),
      fact({
        id: 'obj-now',
        kind: 'OBJECAO',
        subtype: 'preco',
        headline: 'Pediu desconto',
        crop: 'soja',
        region: 'MT',
      }),
      fact({
        id: 'obj-old',
        kind: 'OBJECAO',
        headline: 'Frete',
        occurredAt: new Date('2026-08-18T12:00:00.000Z'),
        crop: 'soja',
        region: 'MT',
      }),
      fact({
        id: 'fu',
        kind: 'FOLLOWUP',
        headline: 'Voltar depois da chuva',
        dueAt: new Date('2026-08-20T12:00:00.000Z'),
        occurredAt: new Date('2026-08-10T12:00:00.000Z'),
        rtvUserId: 'rtv-2',
        rtvName: 'Bruno',
      }),
      fact({
        id: 'comp',
        kind: 'CONCORRENTE',
        headline: 'Citou genérico',
        productKey: 'biologico-x',
      }),
    ];

    const home = buildHome(rows, NOW, WINDOW, 3);
    expect(home.unknownPending).toBe(3);
    expect(home.questions.moneyRisk.count).toBe(1);
    expect(home.questions.moneyRisk.items[0].id).toBe('risk');

    expect(home.questions.objections.count).toBe(1);
    expect(home.questions.objections.groups[0]).toMatchObject({
      crop: 'soja',
      region: 'MT',
      current: 1,
      previous: 1,
      delta: 0,
      growing: false,
    });

    expect(home.questions.followups.overdue).toBe(1);
    expect(home.questions.followups.items[0].id).toBe('fu');

    expect(home.questions.competitor.count).toBe(1);
    expect(home.questions.competitor.items[0].productKey).toBe('biologico-x');

    const bruno = home.questions.rtvHelp.items.find((r) => r.rtvName === 'Bruno');
    expect(bruno?.overdue).toBe(1);
    expect(home.questions.rtvHelp.items[0].rtvName).toBe('Ana');
  });

  it('marks objection groups as growing vs previous window', () => {
    const rows: FactRow[] = [
      fact({
        id: 'a',
        kind: 'OBJECAO',
        headline: 'agora 1',
        occurredAt: new Date('2026-08-25T00:00:00.000Z'),
      }),
      fact({
        id: 'b',
        kind: 'OBJECAO',
        headline: 'agora 2',
        occurredAt: new Date('2026-08-26T00:00:00.000Z'),
      }),
      fact({
        id: 'c',
        kind: 'OBJECAO',
        headline: 'antes',
        occurredAt: new Date('2026-08-18T00:00:00.000Z'),
      }),
    ];
    const home = buildHome(rows, NOW, WINDOW, 0);
    expect(home.questions.objections.groups[0]).toMatchObject({
      current: 2,
      previous: 1,
      delta: 1,
      growing: true,
    });
    expect(home.questions.objections.growing).toBe(1);
  });

  it('applyCuts keeps only the matching farm', () => {
    const rows = [
      fact({ id: '1', kind: 'RISCO', headline: 'a', farmId: 'farm-1' }),
      fact({ id: '2', kind: 'RISCO', headline: 'b', farmId: 'farm-2' }),
    ];
    expect(applyCuts(rows, { farmId: 'farm-2' }).map((r) => r.id)).toEqual(['2']);
  });

  it('ranks RTV with more critical facts first', () => {
    const rows: FactRow[] = [
      fact({
        id: '1',
        kind: 'RISCO',
        severity: 'INFO',
        headline: 'leve',
        rtvUserId: 'rtv-a',
        rtvName: 'Ana',
      }),
      fact({
        id: '2',
        kind: 'RISCO',
        severity: 'CRITICAL',
        headline: 'grave',
        rtvUserId: 'rtv-b',
        rtvName: 'Bia',
      }),
    ];
    const home = buildHome(rows, NOW, WINDOW, 0);
    expect(home.questions.rtvHelp.items.map((r) => r.rtvName)).toEqual(['Bia', 'Ana']);
  });
});
