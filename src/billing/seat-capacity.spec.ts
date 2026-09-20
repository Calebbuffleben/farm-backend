import { Plan } from '@prisma/client';

import { SeatCapacityService } from './seat-capacity.service';
import { SeatLimitReachedException } from './seat-limit.exception';
import { createInMemoryPrismaFake } from '../../test/helpers/prisma-fake';
import { TenantContextService } from '../tenancy/tenant-context.service';

describe('SeatCapacityService', () => {
  function make() {
    const prisma = createInMemoryPrismaFake() as any;
    const tenantCtx = {
      runWithTenantBypass: async <T>(fn: () => Promise<T>) => fn(),
    } as TenantContextService;
    return { prisma, seats: new SeatCapacityService(prisma, tenantCtx) };
  }

  it('counts members + pending invites against the cap', async () => {
    const { prisma, seats } = make();
    const tenant = await prisma.tenant.create({ data: { slug: 's', name: 'S' } });
    await prisma.subscription.create({
      data: { tenantId: tenant.id, plan: Plan.STARTER, maxUsers: 3 },
    });
    const owner = await prisma.user.create({
      data: { email: 'o@s.test', passwordHash: 'x', isActive: true },
    });
    await prisma.membership.create({
      data: { userId: owner.id, tenantId: tenant.id, role: 'OWNER' },
    });
    await prisma.invitation.create({
      data: {
        tenantId: tenant.id,
        email: 'a@s.test',
        tokenHash: 't1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.invitation.create({
      data: {
        tenantId: tenant.id,
        email: 'b@s.test',
        tokenHash: 't2',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cap = await seats.snapshot(tenant.id);
    expect(cap.seatsUsed).toBe(3);
    expect(cap.seatsRemaining).toBe(0);
    await expect(seats.assertCanAddSeat(tenant.id)).rejects.toBeInstanceOf(
      SeatLimitReachedException,
    );
  });

  it('uses pendingMaxUsers as the invite cap during a scheduled downgrade', async () => {
    const { prisma, seats } = make();
    const tenant = await prisma.tenant.create({ data: { slug: 'd', name: 'D' } });
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        plan: Plan.GROWTH,
        maxUsers: 10,
        pendingPlan: Plan.STARTER,
        pendingMaxUsers: 3,
      },
    });
    const owner = await prisma.user.create({
      data: { email: 'o@d.test', passwordHash: 'x', isActive: true },
    });
    await prisma.membership.create({
      data: { userId: owner.id, tenantId: tenant.id, role: 'OWNER' },
    });
    await prisma.membership.create({
      data: {
        userId: (
          await prisma.user.create({
            data: { email: 'm@d.test', passwordHash: 'x', isActive: true },
          })
        ).id,
        tenantId: tenant.id,
        role: 'MEMBER',
      },
    });
    const cap = await seats.snapshot(tenant.id);
    expect(cap.effectiveMaxUsers).toBe(3);
    expect(cap.seatsRemaining).toBe(1);
  });
});
