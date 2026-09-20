import { Plan, SubscriptionStatus } from '@prisma/client';

import {
  denyIfNotEntitled,
  entitlementEnforced,
  isEntitled,
  SUBSCRIPTION_INACTIVE_MESSAGE,
} from './entitlement';

describe('entitlement', () => {
  const ORIGINAL = process.env.BILLING_ENFORCE_ENTITLEMENT;

  afterEach(() => {
    process.env.BILLING_ENFORCE_ENTITLEMENT = ORIGINAL;
  });

  it.each([
    [Plan.STARTER, SubscriptionStatus.ACTIVE, true],
    [Plan.GROWTH, SubscriptionStatus.ACTIVE, true],
    [Plan.SCALE, SubscriptionStatus.ACTIVE, true],
    [Plan.ENTERPRISE, SubscriptionStatus.ACTIVE, true],
    [Plan.FREE, SubscriptionStatus.ACTIVE, false],
    [Plan.GROWTH, SubscriptionStatus.PAST_DUE, true],
    [Plan.GROWTH, SubscriptionStatus.CANCELED, false],
    [Plan.ENTERPRISE, SubscriptionStatus.PAST_DUE, true],
  ])('isEntitled(%s, %s) = %s', (plan, status, expected) => {
    expect(isEntitled(plan, status)).toBe(expected);
  });

  it('keeps access after cancel until currentPeriodEnd', () => {
    const future = new Date(Date.now() + 86_400_000);
    expect(
      isEntitled(Plan.STARTER, SubscriptionStatus.CANCELED, future),
    ).toBe(true);
    const past = new Date(Date.now() - 1000);
    expect(
      isEntitled(Plan.STARTER, SubscriptionStatus.CANCELED, past),
    ).toBe(false);
  });

  it('does not throw when enforcement is off', () => {
    process.env.BILLING_ENFORCE_ENTITLEMENT = 'false';
    expect(entitlementEnforced()).toBe(false);
    expect(() => denyIfNotEntitled(Plan.FREE, SubscriptionStatus.ACTIVE)).not.toThrow();
  });

  it('throws SUBSCRIPTION_INACTIVE when enforcement is on and not entitled', () => {
    process.env.BILLING_ENFORCE_ENTITLEMENT = 'true';
    expect(() => denyIfNotEntitled(Plan.FREE, SubscriptionStatus.ACTIVE)).toThrow(
      SUBSCRIPTION_INACTIVE_MESSAGE,
    );
  });
});
