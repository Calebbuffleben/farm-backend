import { Plan } from '@prisma/client';

/**
 * Catálogo comercial. Fonte única de limites, preços nominais e ordem
 * de upgrade. UI e admin devem importar daqui (ou de GET /billing/catalog)
 * em vez de inlinar constantes.
 *
 * Starter/Growth/Scale são mensalidades fixas em BRL (quantity=1 no Stripe).
 * O teto de assentos é rígido: membro ativo + convite pendente = 1 assento.
 * Enterprise não tem preço de catálogo — `maxUsers` é contratual.
 *
 * FREE permanece no enum só para tenants legados ainda não migrados.
 */
export const PUBLIC_PLANS = ['STARTER', 'GROWTH', 'SCALE'] as const;
export type PublicPlan = (typeof PUBLIC_PLANS)[number];

export const PLAN_MAX_USERS: Record<Plan, number> = {
  FREE: 3,
  STARTER: 3,
  GROWTH: 10,
  SCALE: 25,
  ENTERPRISE: 25,
};

/** Preço de lista em centavos de real (MRR / catálogo). Enterprise é sob consulta. */
export const PLAN_MONTHLY_PRICE_CENTS: Record<Plan, number> = {
  FREE: 0,
  STARTER: 49_700,
  GROWTH: 129_700,
  SCALE: 249_700,
  ENTERPRISE: 0,
};

/** Preço de lista em reais (mesmo valor, para o resumo de MRR do admin). */
export const PLAN_MONTHLY_PRICE: Record<Plan, number> = {
  FREE: 0,
  STARTER: 497,
  GROWTH: 1297,
  SCALE: 2497,
  ENTERPRISE: 0,
};

export const PLAN_DISPLAY_NAME: Record<Plan, string> = {
  FREE: 'Free (legado)',
  STARTER: 'Starter',
  GROWTH: 'Growth',
  SCALE: 'Scale',
  ENTERPRISE: 'Enterprise',
};

export const PLAN_PRICE_ENV: Record<PublicPlan, string> = {
  STARTER: 'STRIPE_PRICE_STARTER',
  GROWTH: 'STRIPE_PRICE_GROWTH',
  SCALE: 'STRIPE_PRICE_SCALE',
};

export const PLAN_ORDER: readonly Plan[] = [
  'FREE',
  'STARTER',
  'GROWTH',
  'SCALE',
  'ENTERPRISE',
];

const PLAN_RANK: Record<Plan, number> = {
  FREE: 0,
  STARTER: 1,
  GROWTH: 2,
  SCALE: 3,
  ENTERPRISE: 4,
};

export function isPublicPlan(plan: Plan | string): plan is PublicPlan {
  return (PUBLIC_PLANS as readonly string[]).includes(plan);
}

export function isPaidPlan(plan: Plan | null | undefined): boolean {
  return (
    plan === Plan.STARTER ||
    plan === Plan.GROWTH ||
    plan === Plan.SCALE ||
    plan === Plan.ENTERPRISE
  );
}

export function isLegacyFree(plan: Plan | null | undefined): boolean {
  return plan === Plan.FREE;
}

export function planToMaxUsers(plan: Plan): number {
  return PLAN_MAX_USERS[plan];
}

export function planRank(plan: Plan): number {
  return PLAN_RANK[plan];
}

export function isUpgrade(from: Plan, to: Plan): boolean {
  return PLAN_RANK[to] > PLAN_RANK[from];
}

export function isDowngrade(from: Plan, to: Plan): boolean {
  return PLAN_RANK[to] < PLAN_RANK[from];
}

/**
 * Planos públicos para os quais o tenant pode mudar sozinho.
 * Enterprise fica de fora (comercial). FREE não é destino.
 */
export function availablePublicPlans(current: Plan): PublicPlan[] {
  return PUBLIC_PLANS.filter((p) => p !== current);
}

export function catalogPayload() {
  return {
    currency: 'BRL',
    plans: PLAN_ORDER.filter((p) => p !== Plan.FREE).map((id) => ({
      id,
      name: PLAN_DISPLAY_NAME[id],
      maxUsers: PLAN_MAX_USERS[id],
      priceCents: PLAN_MONTHLY_PRICE_CENTS[id] || null,
      public: isPublicPlan(id),
      contact: id === Plan.ENTERPRISE,
    })),
  };
}
