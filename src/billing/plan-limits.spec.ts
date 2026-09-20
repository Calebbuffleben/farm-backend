import { Plan } from '@prisma/client';

import {
  catalogPayload,
  isPublicPlan,
  PLAN_MAX_USERS,
  PLAN_MONTHLY_PRICE_CENTS,
  availablePublicPlans,
  planToMaxUsers,
} from './plan-limits';

describe('plan catalog', () => {
  it('exposes seat caps 3/10/25', () => {
    expect(planToMaxUsers(Plan.STARTER)).toBe(3);
    expect(planToMaxUsers(Plan.GROWTH)).toBe(10);
    expect(planToMaxUsers(Plan.SCALE)).toBe(25);
    expect(planToMaxUsers(Plan.ENTERPRISE)).toBe(25);
    expect(PLAN_MAX_USERS.FREE).toBe(3);
  });

  it('prices Starter/Growth/Scale in BRL cents', () => {
    expect(PLAN_MONTHLY_PRICE_CENTS.STARTER).toBe(49_700);
    expect(PLAN_MONTHLY_PRICE_CENTS.GROWTH).toBe(129_700);
    expect(PLAN_MONTHLY_PRICE_CENTS.SCALE).toBe(249_700);
    expect(PLAN_MONTHLY_PRICE_CENTS.ENTERPRISE).toBe(0);
  });

  it('treats only Starter/Growth/Scale as public', () => {
    expect(isPublicPlan(Plan.STARTER)).toBe(true);
    expect(isPublicPlan(Plan.ENTERPRISE)).toBe(false);
    expect(isPublicPlan(Plan.FREE)).toBe(false);
    expect(availablePublicPlans(Plan.STARTER)).toEqual(['GROWTH', 'SCALE']);
  });

  it('omits FREE from the public catalog payload', () => {
    const ids = catalogPayload().plans.map((p) => p.id);
    expect(ids).toEqual(['STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE']);
    expect(catalogPayload().currency).toBe('BRL');
  });
});
