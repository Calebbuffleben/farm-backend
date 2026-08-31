import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthModule } from '../src/auth/auth.module';
import { BillingModule } from '../src/billing/billing.module';
import { StripeBillingService } from '../src/billing/stripe-billing.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { createInMemoryPrismaFake } from './helpers/prisma-fake';

describe('Billing HTTP (e2e)', () => {
  let app: INestApplication;
  const HMAC_SECRET = 'test-e2e-billing-secret-value-1234567890';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = HMAC_SECRET;
    process.env.JWT_ISSUER = 'meet-backend-test';
    process.env.JWT_AUDIENCE = 'meet-platform-test';
    process.env.ALLOW_SELF_SIGNUP = 'true';
    process.env.ALLOW_FREE_PLAN_SWITCH = 'false';
    process.env.BILLING_ENFORCE_ENTITLEMENT = 'false';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent';
    process.env.BILLING_SUCCESS_URL = 'https://landing.test/ok';
    process.env.BILLING_CANCEL_URL = 'https://landing.test/cancel';

    const prisma = createInMemoryPrismaFake();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
        TenancyModule,
        PrismaModule,
        AuthModule,
        BillingModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(StripeBillingService)
      .useValue({
        createCheckoutSession: async () => ({
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test',
        }),
        handleWebhook: async () => ({ received: true }),
        checkoutSuccess: async () => ({
          email: 'a@b.com',
          tenantSlug: 'acme',
          plan: 'PRO',
          downloads: { mac: 'https://x/mac.dmg', win: 'https://x/win.exe' },
        }),
        createPortalSession: async () => ({ url: 'https://billing.stripe.com/p/session' }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /billing/checkout-session returns a checkout URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .send({
        email: 'owner@acme.com',
        password: 'supersecret12',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        plan: 'PRO',
      });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toContain('checkout.stripe.com');
  });

  it('GET /billing/checkout-success returns downloads', async () => {
    const res = await request(app.getHttpServer()).get(
      '/billing/checkout-success?session_id=cs_test',
    );
    expect(res.status).toBe(200);
    expect(res.body.tenantSlug).toBe('acme');
    expect(res.body.downloads.mac).toContain('mac.dmg');
  });

  it('POST /billing/upgrade is 403 when free plan switch is disabled', async () => {
    const register = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'admin@acme.com',
      password: 'supersecret12',
      tenantSlug: 'acme2',
      tenantName: 'Acme 2',
    });
    expect(register.status).toBe(201);
    const token = register.body.accessToken;
    const res = await request(app.getHttpServer())
      .post('/billing/upgrade')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan: 'PRO' });
    expect(res.status).toBe(403);
  });
});
