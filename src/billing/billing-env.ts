import { Logger } from '@nestjs/common';

import { PLAN_PRICE_ENV, PUBLIC_PLANS, type PublicPlan } from './plan-limits';

const logger = new Logger('BillingEnv');

export function stripeSecretConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function publicPriceEnvName(plan: PublicPlan): string {
  return PLAN_PRICE_ENV[plan];
}

export function readPublicPriceId(plan: PublicPlan): string {
  return process.env[PLAN_PRICE_ENV[plan]]?.trim() ?? '';
}

export function collectPublicPriceIds(): Record<PublicPlan, string> {
  return {
    STARTER: readPublicPriceId('STARTER'),
    GROWTH: readPublicPriceId('GROWTH'),
    SCALE: readPublicPriceId('SCALE'),
  };
}

export function missingPublicPriceEnv(): string[] {
  return PUBLIC_PLANS.filter((plan) => !readPublicPriceId(plan)).map(
    (plan) => PLAN_PRICE_ENV[plan],
  );
}

/**
 * When Stripe is configured, the three public Price IDs must exist and be
 * distinct. Throws a plain Error so callers can map it to 503.
 */
export function assertPublicPriceIds(): void {
  const missing = missingPublicPriceEnv();
  if (missing.length) {
    throw new Error(
      `Stripe price IDs missing: ${missing.join(', ')}. Set them in the environment.`,
    );
  }
  const ids = PUBLIC_PLANS.map((plan) => readPublicPriceId(plan));
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      'STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH and STRIPE_PRICE_SCALE must be distinct',
    );
  }
}

/** Warn at boot; never crash — the app should start until credentials are wired. */
export function logBillingEnvOnBoot(): void {
  if (!stripeSecretConfigured()) {
    logger.warn(
      'STRIPE_SECRET_KEY is not set — checkout, portal and webhooks stay disabled until credentials are connected.',
    );
    return;
  }
  const missing = missingPublicPriceEnv();
  if (missing.length) {
    logger.warn(
      `Stripe is partially configured. Missing ${missing.join(', ')} — paid checkout will return 503.`,
    );
    return;
  }
  try {
    assertPublicPriceIds();
    logger.log('Stripe public price IDs configured (Starter/Growth/Scale).');
  } catch (err) {
    logger.warn(err instanceof Error ? err.message : String(err));
  }
}
