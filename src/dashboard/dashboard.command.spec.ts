import {
  applyDealCuts,
  buildAttention,
  buildCommand,
  buildPipeline,
  buildRadar,
  type DealRow,
} from './dashboard.command';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let seq = 0;
function row(overrides: Partial<DealRow> = {}): DealRow {
  seq += 1;
  return {
    conversationId: `conv-${seq}`,
    producerId: `prod-${seq}`,
    producerName: `Produtor ${seq}`,
    producerPhone: null,
    farmNames: ['Chapadão'],
    rtvUserId: 'rtv-a',
    rtvName: 'Ana',
    stage: 'NEGOCIACAO',
    stageConfidence: 0.8,
    contextSummary: 'Quer fechar defensivo antes do plantio.',
    intent: 'MEDIA',
    urgency: 'MEDIA',
    painPoint: null,
    nextAction: 'Confirmar prazo.',
    nextActionKind: 'followup',
    nextActionDueAt: null,
    blockerSubtype: null,
    products: [],
    updatedAt: daysAgo(1),
    lastMessageAt: daysAgo(1),
    lastDirection: 'OUT',
    openComplaints: 0,
    overdueFollowups: 0,
    moneyHints: [],
    crops: ['soja'],
    regions: ['Norte'],
    productKeys: [],
    farmIds: ['farm-1'],
    ...overrides,
  };
}

describe('buildRadar', () => {
  it('conta temperaturas por RTV e ranqueia quem precisa de ajuda', () => {
    const rows = [
      row({ rtvUserId: 'rtv-a', rtvName: 'Ana', intent: 'ALTA' }), // HOT
      row({ rtvUserId: 'rtv-a', rtvName: 'Ana' }), // WARM
      row({ rtvUserId: 'rtv-b', rtvName: 'Bruno', lastMessageAt: daysAgo(12) }), // COOLING
      row({
        rtvUserId: 'rtv-b',
        rtvName: 'Bruno',
        lastMessageAt: hoursAgo(60),
        lastDirection: 'IN',
        openComplaints: 2,
      }), // unanswered
    ];
    const radar = buildRadar(rows, NOW);
    expect(radar[0].rtvName).toBe('Bruno');
    expect(radar[0]).toMatchObject({ cooling: 2, unanswered: 1, complaints: 2 });
    expect(radar[1]).toMatchObject({ rtvName: 'Ana', hot: 1, warm: 1, score: 0 });
  });
});

describe('buildPipeline', () => {
  it('agrupa por estágio e por gargalo com pistas de valor em texto', () => {
    const rows = [
      row({ stage: 'SONDAGEM' }),
      row({ stage: 'NEGOCIACAO', blockerSubtype: 'preco', moneyHints: ['5% desconto'] }),
      row({ stage: 'NEGOCIACAO', blockerSubtype: 'preco', moneyHints: ['50 galões'] }),
      row({ stage: 'FECHAMENTO', blockerSubtype: 'logistica' }),
      row({ stage: 'SEM_NEGOCIO', blockerSubtype: 'preco' }),
    ];
    const pipeline = buildPipeline(rows, NOW);
    expect(pipeline.open).toBe(4);
    const negociacao = pipeline.byStage.find((s) => s.stage === 'NEGOCIACAO');
    expect(negociacao?.count).toBe(2);
    expect(pipeline.byBlocker[0]).toMatchObject({ blockerSubtype: 'preco', count: 2 });
    expect(pipeline.byBlocker[0].moneyHints.sort()).toEqual(['50 galões', '5% desconto'].sort());
    // SEM_NEGOCIO não entra no gargalo
    expect(pipeline.byBlocker.reduce((a, b) => a + b.count, 0)).toBe(3);
  });
});

describe('buildAttention', () => {
  it('prioriza quente com dor, ação vencida e esfriando em fase avançada', () => {
    const quiet = row();
    const hotPain = row({ intent: 'ALTA', painPoint: 'Concorrente parcelou.' });
    const overdue = row({ nextActionDueAt: daysAgo(2) });
    const coolingClose = row({ stage: 'FECHAMENTO', lastMessageAt: daysAgo(9) });
    const unanswered = row({
      stage: 'SONDAGEM',
      lastMessageAt: hoursAgo(72),
      lastDirection: 'IN',
    });
    const noDeal = row({ stage: 'SEM_NEGOCIO', painPoint: 'x', intent: 'ALTA' });

    const attention = buildAttention(
      [quiet, hotPain, overdue, coolingClose, unanswered, noDeal],
      NOW,
    );
    const ids = attention.map((a) => a.conversationId);
    expect(ids).not.toContain(quiet.conversationId);
    expect(ids).not.toContain(noDeal.conversationId);
    expect(ids[0]).toBe(hotPain.conversationId);
    expect(attention[0].reasons).toEqual(['hot_with_pain']);
    expect(attention.find((a) => a.conversationId === coolingClose.conversationId)?.reasons).toEqual([
      'cooling_late_stage',
    ]);
    expect(attention.find((a) => a.conversationId === unanswered.conversationId)?.reasons).toEqual([
      'unanswered',
    ]);
  });

  it('sem resposta em negociação acumula motivos e sobe na lista', () => {
    const stuck = row({ lastMessageAt: hoursAgo(72), lastDirection: 'IN' });
    const [top] = buildAttention([stuck], NOW);
    expect(top.reasons.sort()).toEqual(['cooling_late_stage', 'unanswered']);
    expect(top.priority).toBe(7);
  });
});

describe('applyDealCuts / buildCommand', () => {
  it('aplica os mesmos cortes das 5 perguntas e resume o dia', () => {
    const rows = [
      row({ rtvUserId: 'rtv-a', crops: ['soja'], intent: 'ALTA' }),
      row({ rtvUserId: 'rtv-b', crops: ['milho'], lastMessageAt: daysAgo(10) }),
    ];
    expect(applyDealCuts(rows, { crop: 'milho' })).toHaveLength(1);
    expect(applyDealCuts(rows, { rtvUserId: 'rtv-a' })[0].rtvUserId).toBe('rtv-a');
    const command = buildCommand(rows, NOW);
    expect(command.summary).toMatchObject({ deals: 2, hot: 1, cooling: 1 });
    expect(command.radar).toHaveLength(2);
    expect(command.pipeline.byStage).toHaveLength(5);
  });
});
