import { Plan } from '@prisma/client';

/**
 * Hardcoded plan → seat limit table. Single source of truth for billing
 * logic; importing from anywhere else in the monorepo is preferred over
 * inlining constants to keep changes atomic.
 *
 * Change review: when bumping a plan's limit, also update `PLAN_MONTHLY_PRICE`
 * and `docs/billing.md`.
 */
export const PLAN_MAX_USERS: Record<Plan, number> = {
  FREE: 3,
  PRO: 10,
  ENTERPRISE: 50,
};

/** Monthly list price in USD for MRR estimates (ops + admin billing). */
export const PLAN_MONTHLY_PRICE: Record<Plan, number> = {
  FREE: 0,
  PRO: 49,
  ENTERPRISE: 199,
};

export const PLAN_ORDER: readonly Plan[] = ['FREE', 'PRO', 'ENTERPRISE'];

export function planToMaxUsers(plan: Plan): number {
  return PLAN_MAX_USERS[plan];
}

/**
 * Return the list of plans a tenant can upgrade to from its current one.
 * Downgrades are allowed as long as the current member count fits the
 * target plan (enforced at the service layer).
 */
export function availableUpgrades(current: Plan): Plan[] {
  return PLAN_ORDER.filter((p) => p !== current);
}
