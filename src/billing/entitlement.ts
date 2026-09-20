import { UnauthorizedException } from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

import { isPaidPlan } from './plan-limits';

export const SUBSCRIPTION_INACTIVE_MESSAGE =
  'SUBSCRIPTION_INACTIVE: assinatura inativa — regularize no portal de cobrança';

export function isEntitled(
  plan: Plan | null | undefined,
  status: SubscriptionStatus | null | undefined,
  currentPeriodEnd?: Date | null,
): boolean {
  if (!isPaidPlan(plan)) return false;
  if (status === SubscriptionStatus.ACTIVE) return true;
  // Stripe still collecting — keep access until the subscription is canceled.
  if (status === SubscriptionStatus.PAST_DUE) return true;
  if (status === SubscriptionStatus.CANCELED) {
    return Boolean(
      currentPeriodEnd && currentPeriodEnd.getTime() > Date.now(),
    );
  }
  return false;
}

export function entitlementEnforced(): boolean {
  return process.env.BILLING_ENFORCE_ENTITLEMENT === 'true';
}

export function freePlanSwitchAllowed(): boolean {
  return process.env.ALLOW_FREE_PLAN_SWITCH === 'true';
}

export function denyIfNotEntitled(
  plan: Plan | null | undefined,
  status: SubscriptionStatus | null | undefined,
  currentPeriodEnd?: Date | null,
): void {
  if (!entitlementEnforced()) return;
  if (!isEntitled(plan, status, currentPeriodEnd)) {
    throw new UnauthorizedException(SUBSCRIPTION_INACTIVE_MESSAGE);
  }
}
