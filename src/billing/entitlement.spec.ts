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
    [Plan.PRO, SubscriptionStatus.ACTIVE, true],
    [Plan.ENTERPRISE, SubscriptionStatus.ACTIVE, true],
    [Plan.FREE, SubscriptionStatus.ACTIVE, false],
    [Plan.PRO, SubscriptionStatus.PAST_DUE, false],
    [Plan.PRO, SubscriptionStatus.CANCELED, false],
    [Plan.ENTERPRISE, SubscriptionStatus.PAST_DUE, false],
  ])('isEntitled(%s, %s) = %s', (plan, status, expected) => {
    expect(isEntitled(plan, status)).toBe(expected);
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
