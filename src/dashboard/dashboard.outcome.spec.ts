import {
  buildScoreboard,
  buildSince,
  classifyMovement,
  hintedDiscountPct,
  nextVisit,
  planSync,
  triggersFor,
  type InterventionCandidate,
  type StoredIntervention,
} from './dashboard.outcome';
import { rollingWindow } from './dashboard.queries';

const NOW = new Date('2026-10-02T15:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function candidate(overrides: Partial<InterventionCandidate> = {}): InterventionCandidate {
  return {
    conversationId: 'conv-1',
    stage: 'NEGOCIACAO',
    temperature: 'WARM',
    intent: 'MEDIA',
    urgency: 'MEDIA',
    stageConfidence: 0.8,
    analysisQuality: 'COMPLETE',
    blockerSubtype: null,
    recommendedAction: 'Retornar a cotação',
    recommendedKind: 'followup',
    recommendedOwner: 'RTV',
    dueAt: null,
    managerGuidance: null,
    moneyHints: [],
    evidenceMessageId: 'msg-1',
    rtvUserId: 'rtv-1',
    hasCompetitor: false,
    discountPct: null,
    authorityPct: null,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredIntervention> = {}): StoredIntervention {
  return {
    id: 'int-1',
    conversationId: 'conv-1',
    trigger: 'ESCALATE',
    status: 'OPEN',
    decision: null,
    evidenceMessageId: 'msg-1',
    stage: 'NEGOCIACAO',
    temperature: 'WARM',
    blockerSubtype: null,
    analysisQuality: 'COMPLETE',
    dueAt: null,
    createdAt: hoursAgo(5),
    decidedAt: null,
    executionObservedAt: null,
    expiredAt: null,
    movement: null,
    movementAt: null,
    rtvUserId: 'rtv-1',
    ...overrides,
  };
}

describe('triggersFor', () => {
  it('separa decisão do gerente, fechamento esfriando, alçada e concorrente', () => {
    expect(
      triggersFor(
        candidate({
          recommendedOwner: 'MANAGER',
          recommendedKind: 'escalar_gestor',
          temperature: 'COOLING',
          stage: 'FECHAMENTO',
          blockerSubtype: 'preco',
          discountPct: 8,
          authorityPct: 3,
          hasCompetitor: true,
        }),
      ),
    ).toEqual(['ESCALATE', 'COOLING_CLOSE', 'PRICE_OVER_AUTHORITY', 'COMPETITOR_LATE']);
  });

  it('não abre alerta em análise velha nem sem negócio', () => {
    expect(triggersFor(candidate({ analysisQuality: 'STALE', recommendedOwner: 'MANAGER' }))).toEqual(
      [],
    );
    expect(triggersFor(candidate({ stage: 'SEM_NEGOCIO', recommendedOwner: 'MANAGER' }))).toEqual([]);
  });

  it('só trata desconto acima da alçada quando a pista tem percentual', () => {
    expect(hintedDiscountPct(['50 galões', 'pressão por 5% de desconto'])).toBe(5);
    expect(
      triggersFor(
        candidate({
          blockerSubtype: 'preco',
          moneyHints: ['50 galões'],
          discountPct: null,
          authorityPct: 3,
        }),
      ),
    ).toEqual([]);
  });
});

describe('planSync', () => {
  it('não reabre o mesmo alerta depois de descartado se a evidência não mudou', () => {
    const plan = planSync(
      [candidate({ recommendedOwner: 'MANAGER' })],
      [stored({ trigger: 'MANAGER_OWNER', status: 'DISMISSED', evidenceMessageId: 'msg-1' })],
      NOW,
    );
    expect(plan.create).toHaveLength(0);
  });

  it('reabre quando a evidência é nova e expira prazo vencido sem ação', () => {
    const plan = planSync(
      [candidate({ recommendedOwner: 'MANAGER', evidenceMessageId: 'msg-2', dueAt: hoursAgo(1) })],
      [
        stored({
          id: 'old',
          trigger: 'MANAGER_OWNER',
          status: 'DISMISSED',
          evidenceMessageId: 'msg-1',
        }),
        stored({
          id: 'due',
          conversationId: 'conv-2',
          trigger: 'ESCALATE',
          status: 'ACKNOWLEDGED',
          dueAt: hoursAgo(2),
        }),
      ],
      NOW,
    );
    expect(plan.create.map((row) => row.evidenceMessageId)).toEqual(['msg-2']);
    expect(plan.expireIds).toEqual(['due']);
  });
});

describe('classifyMovement', () => {
  const base = {
    birthStage: 'NEGOCIACAO' as const,
    birthTemperature: 'COOLING' as const,
    currentStage: 'NEGOCIACAO' as const,
    currentTemperature: 'COOLING' as const,
    birthBlocker: 'preco',
    currentBlocker: 'preco',
    dueAt: null,
    now: NOW,
    executed: true,
    newCritical: false,
    newCompetitor: false,
    followupResolved: false,
  };

  it('marca avanço sem chamar de venda salva', () => {
    const result = classifyMovement({ ...base, currentStage: 'FECHAMENTO', currentTemperature: 'WARM' });
    expect(result.movement).toBe('FAVORABLE');
    expect(result.note).toContain('Estágio avançou');
  });

  it('prioriza movimento desfavorável e não trata silêncio fora do canal como falha', () => {
    expect(classifyMovement({ ...base, newCompetitor: true, currentStage: 'FECHAMENTO' }).movement).toBe(
      'UNFAVORABLE',
    );
    expect(classifyMovement({ ...base, executed: false, dueAt: null }).movement).toBeNull();
  });
});

describe('buildScoreboard', () => {
  it('conta decisão, ação observada, movimento posterior e mediana', () => {
    const window = rollingWindow(NOW, 7);
    const board = buildScoreboard(
      [
        stored({ id: 'asked', createdAt: hoursAgo(10) }),
        stored({
          id: 'done',
          status: 'EXECUTED',
          decision: 'DELEGATE',
          decidedAt: hoursAgo(8),
          executionObservedAt: hoursAgo(4),
          movement: 'FAVORABLE',
          movementAt: hoursAgo(2),
          createdAt: hoursAgo(12),
        }),
        stored({
          id: 'late',
          status: 'EXPIRED',
          expiredAt: hoursAgo(1),
          createdAt: hoursAgo(20),
        }),
        stored({
          id: 'partial',
          status: 'EXECUTED',
          decision: 'ASSUME',
          decidedAt: hoursAgo(6),
          executionObservedAt: hoursAgo(3),
          movement: 'FAVORABLE',
          movementAt: hoursAgo(1),
          analysisQuality: 'PARTIAL',
          createdAt: hoursAgo(9),
        }),
      ],
      window,
    );
    expect(board.asked).toHaveLength(4);
    expect(board.decided.map((row) => row.id).sort()).toEqual(['done', 'partial']);
    expect(board.observed).toHaveLength(2);
    expect(board.moved).toHaveLength(2);
    expect(board.partialInMoved).toBe(1);
    expect(board.expired.map((row) => row.id)).toEqual(['late']);
    expect(board.medianReactionHours).toBe(7);
  });
});

describe('visita e movimento desde a última leitura', () => {
  it('a primeira visita não finge delta e a seguinte preserva a âncora na sessão', () => {
    const first = nextVisit(null, NOW);
    expect(first.since).toBeNull();
    const sameSession = nextVisit(
      { visitStartedAt: first.visitStartedAt, visibleSinceAt: first.visibleSinceAt },
      new Date(NOW.getTime() + 30 * 60_000),
    );
    expect(sameSession.since).toBeNull();
    const later = nextVisit(
      { visitStartedAt: first.visitStartedAt, visibleSinceAt: null },
      new Date(NOW.getTime() + 5 * 3_600_000),
    );
    expect(later.since?.toISOString()).toBe(NOW.toISOString());
  });

  it('conta avanço, esfriamento e ameaça sem recontar o mesmo negócio', () => {
    const since = hoursAgo(48);
    const summary = buildSince({
      since,
      threats: 2,
      interventions: [
        stored({ createdAt: hoursAgo(3) }),
        stored({
          id: 'exec',
          executionObservedAt: hoursAgo(2),
          expiredAt: null,
        }),
      ],
      snapshots: [
        {
          conversationId: 'conv-1',
          occurredAt: hoursAgo(72),
          stage: 'SONDAGEM',
          temperature: 'WARM',
        },
        {
          conversationId: 'conv-1',
          occurredAt: hoursAgo(5),
          stage: 'NEGOCIACAO',
          temperature: 'COOLING',
        },
        {
          conversationId: 'conv-1',
          occurredAt: hoursAgo(1),
          stage: 'FECHAMENTO',
          temperature: 'COOLING',
        },
      ],
    });
    expect(summary).toMatchObject({
      newDecisions: 2,
      advanced: 1,
      cooled: 1,
      executed: 1,
      expired: 0,
      threats: 2,
    });
  });
});
