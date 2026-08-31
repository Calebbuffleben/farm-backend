import { Plan, SubscriptionStatus } from '@prisma/client';

import { planToMaxUsers } from './plan-limits';

export type StripeSubLike = {
  id: string;
  customer?: string | { id?: string } | null;
  status?: string | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items?: {
    data?: Array<{
      current_period_end?: number | null;
      price?: { id?: string | null } | null;
    }>;
  } | null;
};

export function planToPriceId(plan: Plan): string {
  const key = plan === Plan.ENTERPRISE ? 'STRIPE_PRICE_ENTERPRISE' : 'STRIPE_PRICE_PRO';
  const id = process.env[key]?.trim();
  if (!id) {
    throw new Error(`${key} is not configured`);
  }
  return id;
}

export function priceIdToPlan(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  const pro = process.env.STRIPE_PRICE_PRO?.trim();
  const ent = process.env.STRIPE_PRICE_ENTERPRISE?.trim();
  if (pro && priceId === pro) return Plan.PRO;
  if (ent && priceId === ent) return Plan.ENTERPRISE;
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
