import { Plan, SubscriptionStatus } from '@prisma/client';

import {
  mappedSubscriptionFields,
  priceIdToPlan,
  stripeStatusToLocal,
} from './stripe-billing.mapper';

describe('stripe-billing.mapper', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent';
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('maps stripe statuses', () => {
    expect(stripeStatusToLocal('active')).toBe(SubscriptionStatus.ACTIVE);
    expect(stripeStatusToLocal('trialing')).toBe(SubscriptionStatus.ACTIVE);
    expect(stripeStatusToLocal('past_due')).toBe(SubscriptionStatus.PAST_DUE);
    expect(stripeStatusToLocal('unpaid')).toBe(SubscriptionStatus.PAST_DUE);
    expect(stripeStatusToLocal('canceled')).toBe(SubscriptionStatus.CANCELED);
    expect(stripeStatusToLocal('incomplete_expired')).toBe(SubscriptionStatus.CANCELED);
  });

  it('maps price ids to plans', () => {
    expect(priceIdToPlan('price_pro')).toBe(Plan.PRO);
    expect(priceIdToPlan('price_ent')).toBe(Plan.ENTERPRISE);
    expect(priceIdToPlan('price_other')).toBeNull();
  });

  it('maps a stripe subscription payload', () => {
    const fields = mappedSubscriptionFields({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: 1_700_000_000,
      items: { data: [{ price: { id: 'price_pro' } }] },
    });
    expect(fields.plan).toBe(Plan.PRO);
    expect(fields.maxUsers).toBe(10);
    expect(fields.status).toBe(SubscriptionStatus.ACTIVE);
    expect(fields.stripeCustomerId).toBe('cus_1');
    expect(fields.cancelAtPeriodEnd).toBe(true);
    expect(fields.currentPeriodEnd).toEqual(new Date(1_700_000_000 * 1000));
  });
});
