import { ConflictException } from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

import { PlatformAdminService } from './platform-admin.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SeatLimitReachedException } from '../billing/seat-limit.exception';

describe('PlatformAdminService billing + invites', () => {
  const tenantCtx = {
    runWithTenantBypass: async <T>(fn: () => Promise<T>) => fn(),
  } as TenantContextService;

  const seats = {
    assertFitsMaxUsers: async () => ({}),
    snapshot: async () => ({ seatsUsed: 1 }),
    lockTenant: async () => undefined,
  } as any;

  it('returns 409 when stripe-linked without force', async () => {
    const prisma = {
      tenant: {
        findUnique: async () => ({
          id: 't1',
          subscription: {
            plan: Plan.GROWTH,
            status: SubscriptionStatus.ACTIVE,
            maxUsers: 10,
            stripeSubscriptionId: 'sub_1',
          },
        }),
      },
    } as any;
    const svc = new PlatformAdminService(prisma, tenantCtx, seats, {} as any);
    await expect(
      svc.updateTenantBilling('t1', { plan: Plan.ENTERPRISE }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows force edit on stripe-linked tenants', async () => {
    const prisma = {
      tenant: {
        findUnique: async () => ({
          id: 't1',
          subscription: {
            plan: Plan.GROWTH,
            status: SubscriptionStatus.ACTIVE,
            maxUsers: 10,
            stripeSubscriptionId: 'sub_1',
          },
        }),
      },
      membership: { count: async () => 1 },
      subscription: {
        update: async () => ({
          id: 's1',
          plan: Plan.ENTERPRISE,
          status: SubscriptionStatus.ACTIVE,
          maxUsers: 25,
        }),
      },
      auditLog: { create: async () => ({}) },
    } as any;
    prisma.tenant.findUnique = async ({ include }: any) => {
      if (include?._count) {
        return { id: 't1', subscription: { plan: Plan.ENTERPRISE } };
      }
      return {
        id: 't1',
        subscription: {
          plan: Plan.GROWTH,
          status: SubscriptionStatus.ACTIVE,
          maxUsers: 10,
          stripeSubscriptionId: 'sub_1',
        },
      };
    };
    const svc = new PlatformAdminService(prisma, tenantCtx, seats, {} as any);
    await expect(
      svc.updateTenantBilling('t1', { plan: Plan.ENTERPRISE, force: true }),
    ).resolves.toBeTruthy();
  });

  it('delegates invites to InvitationsService so seat limits apply', async () => {
    const invitations = {
      create: jest.fn(async () => {
        throw new SeatLimitReachedException('full', { maxUsers: 3, seatsUsed: 3 });
      }),
    };
    const prisma = {
      membership: {
        findFirst: async () => ({ id: 'm1', userId: 'u1' }),
      },
    } as any;
    const svc = new PlatformAdminService(
      prisma,
      tenantCtx,
      seats,
      invitations as any,
    );
    await expect(
      svc.createInvite('t1', { email: 'new@x.test' }),
    ).rejects.toBeInstanceOf(SeatLimitReachedException);
    expect(invitations.create).toHaveBeenCalled();
  });
});
