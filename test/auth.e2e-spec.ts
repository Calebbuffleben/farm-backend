/**
 * e2e tests for the full multi-tenant auth + membership + billing surface.
 *
 * Real HTTP stack (ValidationPipe, middleware, guards, controllers); the
 * PrismaService is replaced by an in-memory fake so the suite is hermetic
 * and runs in CI without Postgres.
 *
 * Covered flows:
 *   - POST /auth/register              — creates User + Tenant + OWNER Membership + FREE Subscription
 *   - POST /auth/login                 — happy + failure + lockout
 *   - POST /auth/refresh               — rotation + family kill on reuse
 *   - GET  /auth/me                    — returns user+membership+tenant+subscription
 *   - POST /auth/service-token         — requires bootstrap key; not usable on HTTP
 *   - GET  /members                    — listing for the authed tenant
 *   - POST /invites                    — admin only, enforces seat limit
 *   - POST /invites/accept-public      — creates new User + Membership
 *   - POST /invites + seat exhaustion  — returns 402 with upgrade hint
 *   - POST /billing/upgrade            — admin only; unblocks new invites
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthModule } from '../src/auth/auth.module';
import { BillingModule } from '../src/billing/billing.module';
import { InvitationsModule } from '../src/invitations/invitations.module';
import { MembersModule } from '../src/members/members.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { createInMemoryPrismaFake } from './helpers/prisma-fake';

describe('Multi-tenant auth + membership + billing (e2e)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createInMemoryPrismaFake>;

  const HMAC_SECRET = 'test-e2e-secret-value-change-me-1234567890';

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = HMAC_SECRET;
    process.env.JWT_ISSUER = 'meet-backend-test';
    process.env.JWT_AUDIENCE = 'meet-platform-test';
    process.env.ALLOW_SELF_SIGNUP = 'true';
    process.env.ALLOW_FREE_PLAN_SWITCH = 'true';
    process.env.SERVICE_BOOTSTRAP_KEY = 'test-bootstrap-key-xyz';
    process.env.AUTH_LOCKOUT_EMAIL_THRESHOLD = '3';
    process.env.AUTH_LOCKOUT_IP_THRESHOLD = '100';
    process.env.AUTH_LOCKOUT_WINDOW_SECONDS = '300';
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  beforeEach(async () => {
    prisma = createInMemoryPrismaFake();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 1000 },
        ]),
        TenancyModule,
        PrismaModule,
        AuthModule,
        BillingModule,
        MembersModule,
        InvitationsModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------------- //
  // Helpers                                                             //
  // ------------------------------------------------------------------- //

  const PASS = 'Sup3rS3cret-passphrase';

  async function registerOwner(slug: string, email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: PASS,
        tenantSlug: slug,
        tenantName: slug.toUpperCase(),
      })
      .expect(201);
    return res.body as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string };
      membership: { id: string; role: string };
      tenant: { id: string; slug: string; name: string };
    };
  }

  async function authHeader(accessToken: string) {
    return { Authorization: `Bearer ${accessToken}` };
  }

  // ------------------------------------------------------------------- //
  // register / login                                                    //
  // ------------------------------------------------------------------- //

  it('POST /auth/register creates OWNER + FREE subscription and returns full session', async () => {
    const body = await registerOwner('acme', 'owner@acme.test');
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.email).toBe('owner@acme.test');
    expect(body.membership.role).toBe('OWNER');
    expect(body.tenant.slug).toBe('acme');

    const subs = prisma._dumpSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].plan).toBe('FREE');
    expect(subs[0].maxUsers).toBe(3);
  });

  it('POST /auth/register rejects duplicate email across tenants', async () => {
    await registerOwner('alpha', 'dup@example.test');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'dup@example.test',
        password: PASS,
        tenantSlug: 'beta',
      })
      .expect(409);
  });

  it('POST /auth/login fails and triggers lockout', async () => {
    await registerOwner('acme', 'user@acme.test');
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'user@acme.test',
          password: 'wrong-password-wrong-password',
          tenantSlug: 'acme',
        })
        .expect(401);
    }
    const locked = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'user@acme.test', password: PASS, tenantSlug: 'acme' })
      .expect(401);
    expect(String(locked.body.message || '')).toMatch(/too many/i);
  });

  it('POST /auth/login without tenantSlug uses the only membership', async () => {
    await registerOwner('sozinho', 'solo@acme.test');
    const body = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'solo@acme.test', password: PASS })
      .expect(200)
      .then((r) => r.body);
    expect(body.tenant.slug).toBe('sozinho');
  });

  it('POST /auth/login blocks users who do not have a membership in the tenant', async () => {
    await registerOwner('tenant-a', 'owner-a@acme.test');
    // This user has no membership in tenant-a.
    await registerOwner('tenant-b', 'owner-b@acme.test');
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'owner-b@acme.test',
        password: PASS,
        tenantSlug: 'tenant-a',
      })
      .expect(401);
  });

  // ------------------------------------------------------------------- //
  // refresh rotation                                                     //
  // ------------------------------------------------------------------- //

  it('POST /auth/refresh rotates tokens and kills the family on reuse', async () => {
    const session = await registerOwner('acme-rotate', 'r@acme.test');
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200)
      .then((r) => r.body);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);
  });

  // ------------------------------------------------------------------- //
  // /auth/me                                                             //
  // ------------------------------------------------------------------- //

  it('GET /auth/me returns membership + subscription snapshot', async () => {
    const session = await registerOwner('acme-me', 'me@acme.test');
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(await authHeader(session.accessToken))
      .expect(200)
      .then((r) => r.body);
    expect(me.user.email).toBe('me@acme.test');
    expect(me.membership.role).toBe('OWNER');
    expect(me.tenant.slug).toBe('acme-me');
    expect(me.subscription.plan).toBe('FREE');
    expect(me.subscription.maxUsers).toBe(3);
    expect(me.subscription.memberCount).toBe(1);
    expect(me.subscription.seatsRemaining).toBe(2);
  });

  // ------------------------------------------------------------------- //
  // /auth/service-token                                                  //
  // ------------------------------------------------------------------- //

  it('POST /auth/service-token requires bootstrap key; result is not usable on HTTP', async () => {
    await request(app.getHttpServer())
      .post('/auth/service-token')
      .send({})
      .expect(403);
    const minted = await request(app.getHttpServer())
      .post('/auth/service-token')
      .set('x-service-bootstrap-key', 'test-bootstrap-key-xyz')
      .send({ label: 'python', ttlSeconds: 120 })
      .expect(200)
      .then((r) => r.body);
    expect(minted.token).toBeTruthy();
    expect(minted.tenantId).toBeNull();
    expect(minted.tenantSlug).toBeNull();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${minted.token}`)
      .expect(401);
  });

  // ------------------------------------------------------------------- //
  // Members                                                              //
  // ------------------------------------------------------------------- //

  it('GET /members lists just the caller on a fresh tenant', async () => {
    const o = await registerOwner('members-1', 'owner@m.test');
    const list = await request(app.getHttpServer())
      .get('/members')
      .set(await authHeader(o.accessToken))
      .expect(200)
      .then((r) => r.body);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('OWNER');
    expect(list[0].email).toBe('owner@m.test');
  });

  // ------------------------------------------------------------------- //
  // Invitations + billing (full lifecycle)                               //
  // ------------------------------------------------------------------- //

  it('invitation lifecycle: create → accept-public → member; then seat limit → upgrade → accept', async () => {
    const owner = await registerOwner('capco', 'owner@capco.test');
    const headers = await authHeader(owner.accessToken);

    // FREE plan = 3 seats. Owner occupies 1 → can invite 2 more without upgrading.
    const i1 = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'one@capco.test' })
      .expect(201)
      .then((r) => r.body);
    expect(i1.token).toBeTruthy();
    expect(i1.status).toBe('PENDING');

    const i2 = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'two@capco.test' })
      .expect(201)
      .then((r) => r.body);

    // Third invite would push seats = 4 (1 owner + 3 pending/members) > 3 → 402.
    const blocked = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'three@capco.test' })
      .expect(402)
      .then((r) => r.body);
    expect(blocked.error).toBe('SeatLimitReached');
    expect(blocked.maxUsers).toBe(3);
    expect(blocked.plan).toBe('FREE');

    // Accept i1 publicly (new user).
    const accepted = await request(app.getHttpServer())
      .post('/invites/accept-public')
      .send({
        token: i1.token,
        password: PASS,
        name: 'One',
      })
      .expect(201)
      .then((r) => r.body);
    expect(accepted.membership.role).toBe('MEMBER');
    expect(accepted.tenant.slug).toBe('capco');
    expect(accepted.accessToken).toBeTruthy();

    // New user can now log in.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'one@capco.test',
        password: PASS,
        tenantSlug: 'capco',
      })
      .expect(200);

    // After accept: memberships=2, pending=1, so still blocked at 3.
    await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'four@capco.test' })
      .expect(402);

    // Upgrade to PRO (=10 seats). Now there is room.
    const sub = await request(app.getHttpServer())
      .post('/billing/upgrade')
      .set(headers)
      .send({ plan: 'PRO' })
      .expect(200)
      .then((r) => r.body);
    expect(sub.plan).toBe('PRO');
    expect(sub.maxUsers).toBe(10);

    // Now we can invite more.
    const i4 = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'four@capco.test' })
      .expect(201)
      .then((r) => r.body);
    expect(i4.status).toBe('PENDING');
  });

  it('POST /invites is admin-only; regular member gets 403', async () => {
    const owner = await registerOwner('guard-co', 'owner@guard.test');
    const headers = await authHeader(owner.accessToken);
    const inv = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'member@guard.test' })
      .expect(201)
      .then((r) => r.body);

    // Accept as new user, then log in as member.
    await request(app.getHttpServer())
      .post('/invites/accept-public')
      .send({ token: inv.token, password: PASS, name: 'Member' })
      .expect(201);
    const memberSession = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'member@guard.test',
        password: PASS,
        tenantSlug: 'guard-co',
      })
      .expect(200)
      .then((r) => r.body);

    // Regular MEMBER cannot invite.
    await request(app.getHttpServer())
      .post('/invites')
      .set({ Authorization: `Bearer ${memberSession.accessToken}` })
      .send({ email: 'nope@guard.test' })
      .expect(403);

    // MEMBER cannot upgrade either.
    await request(app.getHttpServer())
      .post('/billing/upgrade')
      .set({ Authorization: `Bearer ${memberSession.accessToken}` })
      .send({ plan: 'PRO' })
      .expect(403);
  });

  it('POST /invites rejects inviting an existing member or an already-invited email', async () => {
    const owner = await registerOwner('dupe-co', 'owner@dupe.test');
    const headers = await authHeader(owner.accessToken);

    const first = await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'friend@dupe.test' })
      .expect(201)
      .then((r) => r.body);

    // Second invite for same email while first is PENDING → 409.
    await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'friend@dupe.test' })
      .expect(409);

    // Accept it.
    await request(app.getHttpServer())
      .post('/invites/accept-public')
      .send({ token: first.token, password: PASS, name: 'Friend' })
      .expect(201);

    // Now inviting again → 409 (already a member).
    await request(app.getHttpServer())
      .post('/invites')
      .set(headers)
      .send({ email: 'friend@dupe.test' })
      .expect(409);
  });

  it('GET /billing/subscription reports live seat usage', async () => {
    const owner = await registerOwner('usage-co', 'owner@usage.test');
    const headers = await authHeader(owner.accessToken);
    const sub = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set(headers)
      .expect(200)
      .then((r) => r.body);
    expect(sub.plan).toBe('FREE');
    expect(sub.maxUsers).toBe(3);
    expect(sub.memberCount).toBe(1);
    expect(sub.seatsRemaining).toBe(2);
    expect(sub.planLimits.PRO).toBe(10);
    expect(sub.planLimits.ENTERPRISE).toBe(50);
  });

});
