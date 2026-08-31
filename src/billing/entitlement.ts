import { UnauthorizedException } from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

export const SUBSCRIPTION_INACTIVE_MESSAGE =
  'SUBSCRIPTION_INACTIVE: assinatura inativa — regularize no portal de cobrança';

export function isEntitled(
  plan: Plan | null | undefined,
  status: SubscriptionStatus | null | undefined,
): boolean {
  return (
    (plan === Plan.PRO || plan === Plan.ENTERPRISE) &&
    status === SubscriptionStatus.ACTIVE
  );
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
): void {
  if (!entitlementEnforced()) return;
  if (!isEntitled(plan, status)) {
    throw new UnauthorizedException(SUBSCRIPTION_INACTIVE_MESSAGE);
  }
}
