import { Plan, SubscriptionStatus } from '@prisma/client';

import { assertPublicPriceIds, collectPublicPriceIds } from './billing-env';
import { isPublicPlan, planToMaxUsers, type PublicPlan } from './plan-limits';

export type StripeSubLike = {
  id: string;
  customer?: string | { id?: string } | null;
  status?: string | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items?: {
    data?: Array<{
      id?: string | null;
      current_period_end?: number | null;
      price?: { id?: string | null } | null;
    }>;
  } | null;
};

export function planToPriceId(plan: Plan): string {
  if (!isPublicPlan(plan)) {
    throw new Error(`Plan ${plan} has no public Stripe price`);
  }
  assertPublicPriceIds();
  return collectPublicPriceIds()[plan];
}

export function priceIdToPlan(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  const ids = collectPublicPriceIds();
  for (const plan of Object.keys(ids) as PublicPlan[]) {
    if (ids[plan] && priceId === ids[plan]) return plan;
  }
  return null;
}

export function stripeStatusToLocal(status: string | null | undefined): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return SubscriptionStatus.ACTIVE;
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
    case 'incomplete_expired':
      return SubscriptionStatus.CANCELED;
    default:
      return SubscriptionStatus.PAST_DUE;
  }
}

export function customerIdOf(sub: StripeSubLike): string | null {
  const raw = sub.customer;
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw.id ?? null;
}

export function priceIdOf(sub: StripeSubLike): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

export function itemIdOf(sub: StripeSubLike): string | null {
  return sub.items?.data?.[0]?.id ?? null;
}

export function periodEndOf(sub: StripeSubLike): Date | null {
  const unix =
    sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? null;
  if (!unix) return null;
  return new Date(unix * 1000);
}

export function mappedSubscriptionFields(sub: StripeSubLike): {
  status: SubscriptionStatus;
  plan?: Plan;
  maxUsers?: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
} {
  const plan = priceIdToPlan(priceIdOf(sub));
  return {
    status: stripeStatusToLocal(sub.status),
    ...(plan ? { plan, maxUsers: planToMaxUsers(plan) } : {}),
    stripeCustomerId: customerIdOf(sub),
    stripeSubscriptionId: sub.id,
    stripePriceId: priceIdOf(sub),
    currentPeriodEnd: periodEndOf(sub),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}
