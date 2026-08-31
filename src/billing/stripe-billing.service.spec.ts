import { Plan, SubscriptionStatus } from '@prisma/client';
import { ConflictException } from '@nestjs/common';

import { StripeBillingService } from './stripe-billing.service';
import { createInMemoryPrismaFake } from '../../test/helpers/prisma-fake';
import { TenantContextService } from '../tenancy/tenant-context.service';

describe('StripeBillingService provision + apply', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent';
    process.env.BILLING_SUCCESS_URL = 'https://landing.test/ok';
    process.env.BILLING_CANCEL_URL = 'https://landing.test/cancel';
    process.env.BILLING_PORTAL_RETURN_URL = 'https://landing.test/portal';
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  function makeService() {
    const prisma = createInMemoryPrismaFake() as any;
    const tenantCtx = {
      runWithTenantBypass: async <T>(fn: () => Promise<T>) => fn(),
    } as TenantContextService;
    const svc = new StripeBillingService(prisma, tenantCtx);
    return { prisma, svc };
  }

  it('provisions tenant+owner idempotently on checkout.session.completed', async () => {
    const { prisma, svc } = makeService();
    const pending = await prisma.pendingCheckout.create({
      data: {
        email: 'owner@acme.com',
        passwordHash: 'hash',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        plan: Plan.PRO,
        stripeCheckoutSessionId: 'cs_1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(pending.id).toBeTruthy();

    svc.stripeClient = {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_pro' } }] },
        }),
      },
    } as any;

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          subscription: 'sub_1',
          customer: 'cus_1',
        },
      },
    } as any;

    await svc.handleWebhookEvent(event);
    await svc.handleWebhookEvent(event);

    const users = prisma._dumpUsers();
    const tenants = prisma._dumpTenants();
    const subs = prisma._dumpSubscriptions();
    expect(users).toHaveLength(1);
    expect(tenants).toHaveLength(1);
    expect(subs).toHaveLength(1);
    expect(subs[0].plan).toBe(Plan.PRO);
    expect(subs[0].status).toBe(SubscriptionStatus.ACTIVE);
    expect(subs[0].stripeSubscriptionId).toBe('sub_1');
  });

  it('reuses an existing user without changing the password', async () => {
    const { prisma, svc } = makeService();
    const existing = await prisma.user.create({
      data: {
        email: 'owner@acme.com',
        passwordHash: 'original-hash',
        name: 'Old',
        isActive: true,
      },
    });
    await prisma.pendingCheckout.create({
      data: {
        email: 'owner@acme.com',
        passwordHash: 'new-hash',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        plan: Plan.PRO,
        stripeCheckoutSessionId: 'cs_2',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    svc.stripeClient = {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_2',
          customer: 'cus_2',
          status: 'active',
          items: { data: [{ price: { id: 'price_pro' } }] },
        }),
      },
    } as any;
    await svc.handleWebhookEvent({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', subscription: 'sub_2', customer: 'cus_2' } },
    } as any);
    const user = prisma._dumpUsers().find((u: { id: string }) => u.id === existing.id);
    expect(user.passwordHash).toBe('original-hash');
  });

  it('suffixes slug on collision', async () => {
    const { prisma, svc } = makeService();
    await prisma.tenant.create({ data: { slug: 'acme', name: 'Taken' } });
    await prisma.pendingCheckout.create({
      data: {
        email: 'new@acme.com',
        passwordHash: 'hash',
        tenantName: 'Acme 2',
        tenantSlug: 'acme',
        plan: Plan.PRO,
        stripeCheckoutSessionId: 'cs_3',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    svc.stripeClient = {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_3',
          customer: 'cus_3',
          status: 'active',
          items: { data: [{ price: { id: 'price_pro' } }] },
        }),
      },
    } as any;
    await svc.handleWebhookEvent({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_3', subscription: 'sub_3', customer: 'cus_3' } },
    } as any);
    const slugs = prisma._dumpTenants().map((t: { slug: string }) => t.slug);
    expect(slugs).toContain('acme-2');
  });

  it('applySubscriptionState updates status for an existing stripe-linked sub', async () => {
    const { prisma, svc } = makeService();
    const tenant = await prisma.tenant.create({ data: { slug: 't', name: 'T' } });
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        plan: Plan.PRO,
        maxUsers: 10,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: 'sub_live',
      },
    });
    await svc.applySubscriptionState({
      id: 'sub_live',
      status: 'past_due',
      customer: 'cus_x',
      items: { data: [{ price: { id: 'price_pro' } }] },
    });
    expect(prisma._dumpSubscriptions()[0].status).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('syncFromStripe rejects manual tenants', async () => {
    const { prisma, svc } = makeService();
    const tenant = await prisma.tenant.create({ data: { slug: 'm', name: 'M' } });
    await prisma.subscription.create({
      data: { tenantId: tenant.id, plan: Plan.PRO, maxUsers: 10 },
    });
    await expect(svc.syncFromStripe(tenant.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
